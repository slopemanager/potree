import * as THREE from "../../../../libs/three.js/build/three.module.js";
import {
  PointAttribute,
  PointAttributes,
  PointAttributeTypes,
} from "../../../loader/PointAttributes.js";
import { OctreeGeometry, OctreeGeometryNode } from "./OctreeGeometry.js";


// let loadedNodes = new Set();
export class NodeLoader {
  constructor(url, signUrl) {
    this.url = url;
    this.signUrl = signUrl;
    this.auth_headers = Potree.authManager.getHeaders();
  }

  async load(node) {
    // console.log(`loading node`,node);

    if (node.loaded || node.loading) {
      return;
    }

    node.loading = true;
    Potree.numNodesLoading++;

    // console.log(node.name, node.numPoints);

    // if(loadedNodes.has(node.name)){
    // 	// debugger;
    // }
    // loadedNodes.add(node.name);

    try {
      // Proxy Node: points to another chunk
      if (node.nodeType === 2) {
        await this.loadHierarchy(node);
      }

      let { byteOffset, byteSize } = node;

      const lastSlash = this.url.lastIndexOf("/");
      const urlOctree = `${this.url.substring(0, lastSlash + 1)}octree.bin`;

      let first = byteOffset;
      let last = byteOffset + byteSize - 1n; // 1n: verbosely use BigInt precision (num > regular Number)

      let buffer;
      let scalarBufferAttributes = [];

      if (byteSize === 0n) {
        buffer = new ArrayBuffer(0);
        console.warn(`loaded node with 0 bytes: ${node.name}`);
      } else {
        const headers = { Range: `bytes=${first}-${last}` };
        const response = await fetch(await this.signUrl(urlOctree, headers), {
          headers,
        });
        buffer = await response.arrayBuffer();

        // SVX: perform additional range requests to load scalars
        // scalars live next to the octree.bin, in /scalars/{scalar_level}.bin
        for (const scalar of this.registeredExternalScalars) {
          // Scalar attributes have already been parsed (OctreeLoader) and are
          // available in node.octreeGeometry.pointAttributes
          const scalarAttr =
            node.octreeGeometry.pointAttributes.attributes.find(
              (a) => a.name === scalar,
            );

          // Compute scalar byte offsets
          const bpp_octree = BigInt(this.metadata.bpp); //31n;
          const bpp_scalar = BigInt(scalarAttr.byteSize); //2n;

          const scalarFirst = (byteOffset / bpp_octree) * bpp_scalar;
          const scalarByteSize = (byteSize / bpp_octree) * bpp_scalar;

          const scalarLast = scalarFirst + scalarByteSize - 1n;
          const scalarHeaders = { Range: `bytes=${scalarFirst}-${scalarLast}` };

          // Test
          // const idx = first/bpp_octree
          // const scalar_idx = scalarFirst/bpp_scalar
          // console.debug('IDX Test:', {
          //   "idx": idx,
          //   "scalar_idx": scalar_idx,
          // });

          const scalarUrl = `${this.url.substring(0, lastSlash + 1)}scalars/${scalar}.bin`;
          const scalarResponse = await fetch(
            await this.signUrl(scalarUrl, scalarHeaders),
            {
              headers: scalarHeaders,
            },
          );
          const scalarBuffer = await scalarResponse.arrayBuffer();

          // Add to attributes array for worker
          scalarBufferAttributes.push({
            buffer: scalarBuffer,
            byteSize: scalarAttr.byteSize,
            name: scalar,
            attribute: scalarAttr,
          });
        }
        // ---- end SVX scalar loading logic ----
      }

      let workerPath;
      if (this.metadata.encoding === "BROTLI") {
        // console.debug("Using brotli decoder worker");
        workerPath = Potree.scriptPath + "/workers/2.0/DecoderWorker_brotli.js";
      } else {
        // console.debug("Using standard decoder worker");
        workerPath = Potree.scriptPath + "/workers/2.0/DecoderWorker.js";
      }

      let worker = Potree.workerPool.getWorker(workerPath);

      worker.onmessage = function (e) {
        let data = e.data;
        let buffers = data.attributeBuffers;

        Potree.workerPool.returnWorker(workerPath, worker);

        let geometry = new THREE.BufferGeometry();


        for (let property in buffers) {
          let buffer = buffers[property].buffer;

          if (property === "position") {
            geometry.setAttribute(
              "position",
              new THREE.BufferAttribute(new Float32Array(buffer), 3),
            );
          } else if (property === "rgba") {
            geometry.setAttribute(
              "rgba",
              new THREE.BufferAttribute(new Uint8Array(buffer), 4, true),
            );
          } else if (property === "NORMAL") {
            //geometry.setAttribute('rgba', new THREE.BufferAttribute(new Uint8Array(buffer), 4, true));
            geometry.setAttribute(
              "normal",
              new THREE.BufferAttribute(new Float32Array(buffer), 3),
            );
          } else if (property === "INDICES") {
            let bufferAttribute = new THREE.BufferAttribute(
              new Uint8Array(buffer),
              4,
            );
            bufferAttribute.normalized = true;
            geometry.setAttribute("indices", bufferAttribute);
          } 
          else if (property === "segmentation") {
            const bufferAttribute = new THREE.BufferAttribute(
              new Float32Array(buffer),
              1,
            );

            let batchAttribute = buffers[property].attribute;
            bufferAttribute.potree = {
              offset: buffers[property].offset,
              scale: buffers[property].scale,
              preciseBuffer: buffers[property].preciseBuffer,
              range: batchAttribute.range,
            };

            if (geometry.getAttribute("segmentation")) {
              continue;
            }

            geometry.setAttribute("segmentation", bufferAttribute);
          } else {
            const bufferAttribute = new THREE.BufferAttribute(
              new Float32Array(buffer),
              1,
            );

            let batchAttribute = buffers[property].attribute;
            bufferAttribute.potree = {
              offset: buffers[property].offset,
              scale: buffers[property].scale,
              preciseBuffer: buffers[property].preciseBuffer,
              range: batchAttribute.range,
            };

            geometry.setAttribute(property, bufferAttribute);
          }
        }

        node.density = data.density;
        node.geometry = geometry;
        node.loaded = true;
        node.loading = false;
        Potree.numNodesLoading--;
      };

      let pointAttributes = node.octreeGeometry.pointAttributes;
      let scale = node.octreeGeometry.scale;

      let box = node.boundingBox;
      let min = node.octreeGeometry.offset.clone().add(box.min);
      let size = box.max.clone().sub(box.min);
      let max = min.clone().add(size);
      let numPoints = node.numPoints;

      let offset = node.octreeGeometry.loader.offset;

      let message = {
        name: node.name,
        buffer: buffer,
        pointAttributes: pointAttributes,
        scalarBuffer:
          scalarBufferAttributes.length > 0
            ? {
                attributes: scalarBufferAttributes,
              }
            : null,
        scale: scale,
        min: min,
        max: max,
        size: size,
        offset: offset,
        numPoints: numPoints,
      };
      // console.log("Posting message to worker:", message);

      worker.postMessage(message, [message.buffer]);
    } catch (e) {
      node.loaded = false;
      node.loading = false;
      Potree.numNodesLoading--;

      console.log(`failed to load ${node.name}`);
      console.log(e);
      console.log(`trying again!`);
    }
  }

  parseHierarchy(node, buffer) {
    let view = new DataView(buffer);
    let tStart = performance.now();

    let bytesPerNode = 22;
    let numNodes = buffer.byteLength / bytesPerNode;

    let octree = node.octreeGeometry;
    // let nodes = [node];
    let nodes = new Array(numNodes);
    nodes[0] = node;
    let nodePos = 1;

    // console.log(`Will parse ${numNodes} nodes (bbg/bpn = ${buffer.byteLength}/${bytesPerNode})`);

    for (let i = 0; i < numNodes; i++) {
      let current = nodes[i];

      let type = view.getUint8(i * bytesPerNode + 0);
      let childMask = view.getUint8(i * bytesPerNode + 1);
      let numPoints = view.getUint32(i * bytesPerNode + 2, true);
      let byteOffset = view.getBigInt64(i * bytesPerNode + 6, true);
      let byteSize = view.getBigInt64(i * bytesPerNode + 14, true);

      // if(byteSize === 0n){
      // 	// debugger;
      // }

      if (current.nodeType === 2) {
        // replace proxy with real node
        current.byteOffset = byteOffset;
        current.byteSize = byteSize;
        current.numPoints = numPoints;
      } else if (type === 2) {
        // load proxy
        current.hierarchyByteOffset = byteOffset;
        current.hierarchyByteSize = byteSize;
        current.numPoints = numPoints;
      } else {
        // load real node
        current.byteOffset = byteOffset;
        current.byteSize = byteSize;
        current.numPoints = numPoints;
      }

      current.nodeType = type;

      if (current.nodeType === 2) {
        continue;
      }

      for (let childIndex = 0; childIndex < 8; childIndex++) {
        let childExists = ((1 << childIndex) & childMask) !== 0;

        if (!childExists) {
          continue;
        }

        let childName = current.name + childIndex;

        let childAABB = createChildAABB(current.boundingBox, childIndex);
        let child = new OctreeGeometryNode(childName, octree, childAABB);
        child.name = childName;
        child.spacing = current.spacing / 2;
        child.level = current.level + 1;

        current.children[childIndex] = child;
        child.parent = current;

        // nodes.push(child);
        nodes[nodePos] = child;
        // console.log("Nodes", nodes.length, nodes)
        nodePos++;
      }

      // if((i % 500) === 0){
      // 	yield;
      // }
    }

    let duration = performance.now() - tStart;

    // if(duration > 20){
    // 	let msg = `duration: ${duration}ms, numNodes: ${numNodes}`;
    // 	console.log(msg);
    // }
  }

  async loadHierarchy(node) {
    let { hierarchyByteOffset, hierarchyByteSize } = node;
    const lastSlash = this.url.lastIndexOf("/");
    const hierarchyPath = `${this.url.substring(
      0,
      lastSlash + 1,
    )}hierarchy.bin`;
    let first = hierarchyByteOffset;
    let last = first + hierarchyByteSize - 1n;

    const headers = { Range: `bytes=${first}-${last}` };
    const response = await fetch(await this.signUrl(hierarchyPath, headers), {
      headers,
    });
    let buffer = await response.arrayBuffer();

    this.parseHierarchy(node, buffer);

    // let promise = new Promise((resolve) => {
    // 	let generator = this.parseHierarchy(node, buffer);

    // 	let repeatUntilDone = () => {
    // 		let result = generator.next();

    // 		if(result.done){
    // 			resolve();
    // 		}else{
    // 			requestAnimationFrame(repeatUntilDone);
    // 		}
    // 	};

    // 	repeatUntilDone();
    // });

    // await promise;
  }
}

let tmpVec3 = new THREE.Vector3();
function createChildAABB(aabb, index) {
  let min = aabb.min.clone();
  let max = aabb.max.clone();
  let size = tmpVec3.subVectors(max, min);

  if ((index & 0b0001) > 0) {
    min.z += size.z / 2;
  } else {
    max.z -= size.z / 2;
  }

  if ((index & 0b0010) > 0) {
    min.y += size.y / 2;
  } else {
    max.y -= size.y / 2;
  }

  if ((index & 0b0100) > 0) {
    min.x += size.x / 2;
  } else {
    max.x -= size.x / 2;
  }

  return new THREE.Box3(min, max);
}

let typenameTypeattributeMap = {
  double: PointAttributeTypes.DATA_TYPE_DOUBLE,
  float: PointAttributeTypes.DATA_TYPE_FLOAT,
  int8: PointAttributeTypes.DATA_TYPE_INT8,
  uint8: PointAttributeTypes.DATA_TYPE_UINT8,
  int16: PointAttributeTypes.DATA_TYPE_INT16,
  uint16: PointAttributeTypes.DATA_TYPE_UINT16,
  int32: PointAttributeTypes.DATA_TYPE_INT32,
  uint32: PointAttributeTypes.DATA_TYPE_UINT32,
  int64: PointAttributeTypes.DATA_TYPE_INT64,
  uint64: PointAttributeTypes.DATA_TYPE_UINT64,
};

export class OctreeLoader {
  static parseAttributes(jsonAttributes) {
    let attributes = new PointAttributes();

    let replacements = {
      rgb: "rgba",
    };

    for (const jsonAttribute of jsonAttributes) {
      let { name, description, size, numElements, elementSize, min, max } =
        jsonAttribute;

      let type = typenameTypeattributeMap[jsonAttribute.type];

      let potreeAttributeName = replacements[name] ? replacements[name] : name;

      let attribute = new PointAttribute(
        potreeAttributeName,
        type,
        numElements,
      );

      if (numElements === 1) {
        attribute.range = [min[0], max[0]];
      } else {
        attribute.range = [min, max];
      }

      if (name === "gps-time") {
        // HACK: Guard against bad gpsTime range in metadata, see potree/potree#909
        if (attribute.range[0] === attribute.range[1]) {
          attribute.range[1] += 1;
        }
      }

      attribute.initialRange = attribute.range;

      attributes.add(attribute);
    }

    {
      // check if it has normals
      let hasNormals =
        attributes.attributes.find((a) => a.name === "NormalX") !== undefined &&
        attributes.attributes.find((a) => a.name === "NormalY") !== undefined &&
        attributes.attributes.find((a) => a.name === "NormalZ") !== undefined;

      if (hasNormals) {
        let vector = {
          name: "NORMAL",
          attributes: ["NormalX", "NormalY", "NormalZ"],
        };
        attributes.addVector(vector);
      }
    }

    return attributes;
  }

  static async load(url, signUrl) {
    const response = await fetch(await signUrl(url));
    if (!response.ok) {
      // AWS "file not found" with signed URL returns 403
      if ([403, 404].includes(response.status)) {
        return {};
      }
      throw new Error(
        `Fetch error type: ${response.type}, status: ${response.status} ${response.statusText}`,
      );
    }
    let metadata = await response.json();

    let attributes = OctreeLoader.parseAttributes(metadata.attributes);
    // SVX: Parse scalar attributes as well, if they exist. These will be loaded via separate range requests in NodeLoader.load()
    let scalarAttributes = OctreeLoader.parseAttributes(
      metadata.scalarAttributes || [],
    );

    // console.debug("[OctreeLoader] Parsed metadata:", metadata);
    // console.debug("[OctreeLoader] Parsed attributes:", attributes);
    // console.debug("[OctreeLoader] Parsed scalar attributes:", scalarAttributes);

    let loader = new NodeLoader(url, signUrl);
    loader.metadata = metadata;
    loader.attributes = attributes;
    // SVX: Store scalar attributes in loader for access in NodeLoader.load()
    loader.scalarAttributes = scalarAttributes;
    loader.scale = metadata.scale;
    loader.offset = metadata.offset;

    // SVX: Pass registered scalar attributes to loader as well, for access in NodeLoader.load()
    const registeredExternalScalars = metadata.scalarAttributes
      ? metadata.scalarAttributes.map((attr) => attr.name)
      : [];
    console.debug("[OctreeLoader] Registered external scalar attributes:", registeredExternalScalars);
    loader.registeredExternalScalars = registeredExternalScalars;

    let octree = new OctreeGeometry();
    octree.url = url;
    octree.spacing = metadata.spacing;
    octree.scale = metadata.scale;

    // let aPosition = metadata.attributes.find(a => a.name === "position");
    // octree

    let min = new THREE.Vector3(...metadata.boundingBox.min);
    let max = new THREE.Vector3(...metadata.boundingBox.max);
    let boundingBox = new THREE.Box3(min, max);

    let offset = min.clone();
    boundingBox.min.sub(offset);
    boundingBox.max.sub(offset);

    octree.projection = metadata.projection;
    octree.boundingBox = boundingBox;
    octree.tightBoundingBox = boundingBox.clone();
    octree.boundingSphere = boundingBox.getBoundingSphere(new THREE.Sphere());
    octree.tightBoundingSphere = boundingBox.getBoundingSphere(
      new THREE.Sphere(),
    );
    octree.offset = offset;

    // SVX: Compose point attributes from octree attributes and scalar attributes
    const composedAttributes = [
      ...metadata.attributes,
      ...(metadata.scalarAttributes || []),
    ];
    octree.pointAttributes = OctreeLoader.parseAttributes(composedAttributes);
    // ORIGINAL: octree.pointAttributes = OctreeLoader.parseAttributes(metadata.attributes);


    octree.loader = loader;

    let root = new OctreeGeometryNode("r", octree, boundingBox);
    root.level = 0;
    root.nodeType = 2;
    root.hierarchyByteOffset = 0n;
    root.hierarchyByteSize = BigInt(metadata.hierarchy.firstChunkSize);
    root.hasChildren = false;
    root.spacing = octree.spacing;
    root.byteOffset = 0;

    octree.root = root;

    loader.load(root);

    // console.log("octree", octree);
    let result = {
      geometry: octree,
    };

    return result;
  }
}
