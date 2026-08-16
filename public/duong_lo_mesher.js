// duong_lo_mesher.js
// Builds unified 3-D volumetric surface meshes for mine tunnel (đường lò) networks
// using three-bvh-csg to eliminate interior blocking walls at T-junctions.

import * as THREE from 'three';
import { Evaluator, Brush, ADDITION } from 'three-bvh-csg';

// ── Helpers ──────────────────────────────────────────────────────────────────

function interpAtY(pts, y) {
    for (let i = 0; i < pts.length - 1; i++) {
        const ya = pts[i].y, yb = pts[i + 1].y;
        const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
        if (y >= lo - 1e-6 && y <= hi + 1e-6) {
            const t = Math.abs(yb - ya) < 1e-10 ? 0 : (y - ya) / (yb - ya);
            return new THREE.Vector3(
                pts[i].x + t * (pts[i + 1].x - pts[i].x),
                y,
                pts[i].z + t * (pts[i + 1].z - pts[i].z)
            );
        }
    }
    return null;
}

function circumArc(P1, P2, P3, nSegs = 16) {
    const a  = P2.clone().sub(P1);
    const b  = P3.clone().sub(P1);
    const n  = new THREE.Vector3().crossVectors(a, b);
    const n2 = n.dot(n);

    if (n2 < 1e-12) {
        return Array.from({ length: nSegs + 1 }, (_, i) => P1.clone().lerp(P3, i / nSegs));
    }

    const a2 = a.dot(a), b2 = b.dot(b);
    const center = P1.clone().add(
        new THREE.Vector3().crossVectors(b, n).multiplyScalar(a2)
            .add(new THREE.Vector3().crossVectors(n, a).multiplyScalar(b2))
            .divideScalar(2 * n2)
    );

    const R   = center.distanceTo(P1);
    const u   = P1.clone().sub(center).divideScalar(R);
    const nHat = n.clone().normalize();
    const v   = new THREE.Vector3().crossVectors(nHat, u).normalize();

    const r3 = P3.clone().sub(center);
    let   a3 = Math.atan2(r3.dot(v), r3.dot(u));
    const r2 = P2.clone().sub(center);
    let   a2p = Math.atan2(r2.dot(v), r2.dot(u));

    if (a3 <= 0) a3 += 2 * Math.PI;
    if (a2p <= 0) a2p += 2 * Math.PI;
    if (a2p > a3) a3 -= 2 * Math.PI;

    return Array.from({ length: nSegs + 1 }, (_, i) => {
        const θ = (i / nSegs) * a3;
        return center.clone()
            .add(u.clone().multiplyScalar(R * Math.cos(θ)))
            .add(v.clone().multiplyScalar(R * Math.sin(θ)));
    });
}

// Clones each point in a line/segment array and subtracts the shared global
// offset, WITHOUT mutating the originals — those same array references are
// also used elsewhere (e.g. main.js) to render the raw colored contour lines.
function offsetLine(segArr, globalOffset) {
    return segArr.map(p => p.clone().sub(globalOffset));
}

// ── Multi-Material Floor Splitter (Safe for Non-Indexed Geometries) ───────────

function splitFloorMaterial(geom) {
    // If ExtrudeGeometry didn't create an index, convert it to an indexed geometry first
    if (!geom.index) {
        const pos = geom.attributes.position;
        const count = pos.count;
        const indices = new Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
        geom.setIndex(indices);
    }

    const pos = geom.attributes.position;
    const oldIdx = geom.index.array;
    const oldGroups = geom.groups;
    
    const newIndices = [];
    const newGroups = [];
    
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), faceNormal = new THREE.Vector3();
    
    for (const g of oldGroups) {
        if (g.materialIndex === 0) {
            const start = newIndices.length;
            for (let i = g.start; i < g.start + g.count; i++) {
                newIndices.push(oldIdx[i]);
            }
            newGroups.push({ start: start, count: g.count, materialIndex: 0 });
        } else {
            const wallIndices = [];
            const floorIndices = [];
            
            for (let i = g.start; i < g.start + g.count; i += 3) {
                const a = oldIdx[i];
                const b = oldIdx[i+1];
                const c = oldIdx[i+2];
                
                vA.fromBufferAttribute(pos, a);
                vB.fromBufferAttribute(pos, b);
                vC.fromBufferAttribute(pos, c);
                
                ab.subVectors(vB, vA);
                ac.subVectors(vC, vA);
                faceNormal.crossVectors(ab, ac).normalize();
                
                // Downward facing triangles (-Z axis) are classified as the floor
                if (faceNormal.z < -0.5) {
                    floorIndices.push(a, b, c);
                } else {
                    wallIndices.push(a, b, c);
                }
            }
            
            if (wallIndices.length > 0) {
                const start = newIndices.length;
                newIndices.push(...wallIndices);
                newGroups.push({ start: start, count: wallIndices.length, materialIndex: 1 });
            }
            if (floorIndices.length > 0) {
                const start = newIndices.length;
                newIndices.push(...floorIndices);
                newGroups.push({ start: start, count: floorIndices.length, materialIndex: 2 });
            }
        }
    }
    
    geom.setIndex(newIndices);
    geom.groups = newGroups;
}

// ── Loai 1: Watertight Solid Builder ────────────────────────────────────────

function createClosedSolidGeometry(rings) {
    if (rings.length < 2 || rings[0].length < 3) return null;

    const numRows = rings.length;
    const cols = rings[0].length;
    const vertices = [];
    const indices = [];
    const uvs = [];

    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < cols; c++) {
            const p = rings[r][c];
            vertices.push(p.x, p.y, p.z);
            uvs.push(0, 0); 
        }
    }

    for (let r = 0; r < numRows - 1; r++) {
        for (let c = 0; c < cols; c++) {
            const nextC = (c + 1) % cols;
            const a = r * cols + c;
            const b = r * cols + nextC;
            const cIdx = (r + 1) * cols + nextC;
            const d = (r + 1) * cols + c;

            indices.push(a, b, cIdx);
            indices.push(a, cIdx, d);
        }
    }

    for (let c = 1; c < cols - 1; c++) {
        indices.push(0, c, c + 1); 
    }
    const lastRowBase = (numRows - 1) * cols;
    for (let c = 1; c < cols - 1; c++) {
        indices.push(lastRowBase, lastRowBase + c + 1, lastRowBase + c); 
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geom.computeVertexNormals();
    
    if (geom.attributes.position.count === 0 || geom.index.count === 0) return null;

    const quadIndices = (numRows - 1) * cols * 6;
    const capIndices = (cols - 2) * 3 * 2; 
    geom.addGroup(0, quadIndices, 1); 
    geom.addGroup(quadIndices, capIndices, 0); 

    return geom;
}

function generateLoai1Geometry(nocLine, bienL, bienR, nenLine, wallHeight, ARC_SEGS = 14) {
    const yLo = Math.max(
        Math.min(...nocLine.map(p => p.y)),
        Math.min(...bienL.map(p => p.y)),
        Math.min(...bienR.map(p => p.y)),
        ...(nenLine ? [Math.min(...nenLine.map(p => p.y))] : [])
    );
    const yHi = Math.min(
        Math.max(...nocLine.map(p => p.y)),
        Math.max(...bienL.map(p => p.y)),
        Math.max(...bienR.map(p => p.y)),
        ...(nenLine ? [Math.max(...nenLine.map(p => p.y))] : [])
    );
    if (yLo >= yHi) return null;

    const stationYs = nocLine.map(p => p.y).filter(y => y >= yLo && y <= yHi);
    if (stationYs.length < 2) return null;

    const rings = [];
    for (const y of stationYs) {
        const pNoc = interpAtY(nocLine, y);
        const pBL  = interpAtY(bienL, y);
        const pBR  = interpAtY(bienR, y);
        if (!pNoc || !pBL || !pBR) continue;

        const pNoc_top = new THREE.Vector3(pNoc.x, y, pNoc.z + wallHeight);
        const pBL_top  = new THREE.Vector3(pBL.x, y, pBL.z + wallHeight);
        const pBR_top  = new THREE.Vector3(pBR.x, y, pBR.z + wallHeight);

        const archPts = circumArc(pBL_top, pNoc_top, pBR_top, ARC_SEGS);
        const wallRPts = wallHeight > 0 ? [pBR.clone()] : [];
        const floorPts = [];
        if (nenLine) {
            const pN = interpAtY(nenLine, y);
            floorPts.push(pN ? pN : pBL.clone().lerp(pBR, 0.5));
        }
        floorPts.push(pBL.clone());

        const ring = [...archPts, ...wallRPts, ...floorPts];
        rings.push(ring);
    }

    return createClosedSolidGeometry(rings);
}

// ── Loai 2: Extrusion Generators ────────────────────────────────────────────

function generateLoai2Geometries(nenSegs, tietDienSegs, materials, globalOffset) {
    const brushes = [];
    if (!nenSegs.length || !tietDienSegs.length) return brushes;

    const shapeMap = new Map();
    let fallbackShape = null;

    for (const td of tietDienSegs) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        
        const xs = td.map(p => p.x);
        const ys = td.map(p => p.y); 
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

        const profile = new THREE.Shape();
        const first = td[0], last = td[td.length - 1];
        let pts = [...td];
        
        if (Math.abs(first.x - last.x) < 1e-4 && Math.abs(first.y - last.y) < 1e-4) {
            pts.pop();
        }

        pts.forEach((p, i) => {
            const px = p.x - cx;
            const py = p.y - cy; 
            if (i === 0) profile.moveTo(px, py);
            else profile.lineTo(px, py);
        });
        
        shapeMap.set(td.tietDienName, profile);
        if (!fallbackShape) fallbackShape = profile;
    }

    for (const nenSeg of nenSegs) {
        if (nenSeg.length < 2) continue;
        const profile = shapeMap.get(nenSeg.tietDienName) || fallbackShape;
        if (!profile) continue;

        const pts = nenSeg.map(p => new THREE.Vector3(p.x, p.y, p.z).sub(globalOffset));
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);

        curve.computeFrenetFrames = function(steps) {
            const tangents = [], normals = [], binormals = [];
            for ( let i = 0; i <= steps; i ++ ) {
                const t = this.getTangentAt(i / steps).normalize();
                tangents.push(t);

                let up = new THREE.Vector3(0, 0, 1); 
                let b = up.clone();
                let n = new THREE.Vector3().crossVectors(b, t);
                
                if (n.lengthSq() < 1e-10) {
                    n.set(1, 0, 0); 
                } else {
                    n.normalize();
                }

                b.crossVectors(t, n).normalize();
                normals.push(n);
                binormals.push(b);
            }
            return { tangents, normals, binormals };
        };

        const geom = new THREE.ExtrudeGeometry(profile, {
            steps: pts.length * 4,
            bevelEnabled: false,
            extrudePath: curve
        });

        // Split the floor out to Material Index 2
        splitFloorMaterial(geom);

        const brush = new Brush(geom, materials);
        brush.updateMatrixWorld();
        brushes.push(brush);
    }

    return brushes;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildDuongLoMesh(rawDataSegments, meshGroup, wallHeight = 0) {
    let globalOffset = null;
    for (const seg of rawDataSegments) {
        if (!seg.isDuongLo) continue;
        if (!globalOffset && seg.length) globalOffset = seg[0].clone();
    }
    // Defensive fallback — avoids a crash if no isDuongLo segments were found
    if (!globalOffset) globalOffset = new THREE.Vector3(0, 0, 0);

    const tunnels = new Map(); 
    for (const seg of rawDataSegments) {
        if (!seg.isDuongLo) continue;
        const name = seg.blockName || '__default__';
        if (!tunnels.has(name)) tunnels.set(name, { nen: [], noc: [], bien: [], tietDien: [] });
        const t     = tunnels.get(name);
        const layer = seg.duongLoLayer || '';
        
        if      (layer === 'nen')       t.nen.push(seg);
        else if (layer === 'noc')       t.noc.push(seg);
        else if (layer === 'bien')      t.bien.push(seg);
        else if (layer === 'tiet dien') t.tietDien.push(seg);
    }

    const old = meshGroup.getObjectByName('DuongLo_Meshes');
    if (old) {
        old.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        meshGroup.remove(old);
    }
    const grp = new THREE.Group();
    grp.name = 'DuongLo_Meshes';
    meshGroup.add(grp);

    const evaluator = new Evaluator();
    evaluator.useGroups = true; 

    // ── The 3 Material Slots ──
    const capMaterial = new THREE.MeshBasicMaterial({ visible: false });
    
    // Index 1: Blue Arch and Walls
    const wallMaterial = new THREE.MeshBasicMaterial({
        color: 0x4488cc,
        side: THREE.DoubleSide
    });
    
    // Index 2: Orange Floor
    const floorMaterial = new THREE.MeshBasicMaterial({
        color: 0xc89060,
        side: THREE.DoubleSide
    });
    
    const materials = [capMaterial, wallMaterial, floorMaterial];

    const allBrushes = [];

    for (const [tunnelName, { nen, noc, bien, tietDien }] of tunnels) {
        
        if (tietDien.length > 0) {
            if (!nen.length) {
                console.warn(`[DuongLo Loai2] "${tunnelName}" — missing Nền path.`);
                continue;
            }
            const brushes = generateLoai2Geometries(nen, tietDien, materials, globalOffset);
            allBrushes.push(...brushes);
            
        } else if (noc.length > 0 && bien.length >= 2) {
            const sorted = [...bien].sort((A, B) => {
                const ax = A.reduce((s, p) => s + p.x, 0) / A.length;
                const bx = B.reduce((s, p) => s + p.x, 0) / B.length;
                return ax - bx;
            });
            const nocLine = offsetLine(noc[0], globalOffset);
            const bienL   = offsetLine(sorted[0], globalOffset);
            const bienR   = offsetLine(sorted[sorted.length - 1], globalOffset);
            const nenLine = nen.length > 0 ? offsetLine(nen[0], globalOffset) : null;

            const geom = generateLoai1Geometry(nocLine, bienL, bienR, nenLine, wallHeight);
            if (geom) {
                // Split the floor out to Material Index 2
                splitFloorMaterial(geom);
                
                const brush = new Brush(geom, materials);
                brush.updateMatrixWorld();
                allBrushes.push(brush);
            }
        }
    }

    if (allBrushes.length === 0) return;

    console.log(`[DuongLo CSG] Starting union on ${allBrushes.length} tunnel branches...`);
    let combinedMesh = allBrushes[0];

    for (let i = 1; i < allBrushes.length; i++) {
        try {
            combinedMesh = evaluator.evaluate(combinedMesh, allBrushes[i], ADDITION);
        } catch (err) {
            console.warn(`[CSG Union] Failed merging segment ${i}:`, err);
        }
    }

    combinedMesh.name = 'DuongLo_Unified_CSG_Mesh';
    combinedMesh.castShadow = true;
    combinedMesh.receiveShadow = true;
    combinedMesh.position.copy(globalOffset);
    combinedMesh.updateMatrixWorld(true);
    grp.add(combinedMesh);

    console.log(`[DuongLo CSG] Successfully united tunnel network.`);
}