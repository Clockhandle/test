# Hybrid mesh samples

Two input files for the **Hybrid Mesh** button. They reproduce the three hybrid tests: z-stitch where CGAL's
2.5D triangulation can't represent the surface, CGAL CDT everywhere else, both welded into one mesh along a
shared seam. Upload either file in the app, then press **Hybrid Mesh**. Stitched triangles are amber and
seams are red. Press **CGAL Mesh** to compare.

| File | Test | Surface | How the stitch region is chosen |
|---|---|---|---|
| `hybrid_test1_circle.json` | 1: circle | Vách | `IsStitchRegion` polygon: a 20 m circle over the middle of the Vách. Inside it is z-stitched; outside, CGAL uses the cut edge as a hole. |
| `hybrid_test2_3_band_crossing.json` | 2: contour split | Vách | `IsStitchRegion` with `StitchZMin: -340`, `StitchZMax: -100`. Contours in that band are stitched. The hooked -380 contour and the curved border below -340 go to CGAL, with the -340 contour as the seam. |
| `hybrid_test2_3_band_crossing.json` | 3: crossings | Trụ | Automatic. The -150 contour crosses -160 twice in plan, so a capsule around the crossings is z-stitched. Contours are cut at the capsule, so CGAL never sees a crossing. |

Test 1 uses `Via_test.json` plus the circle entity. Tests 2 and 3 use `via_test_3.json` plus the band entity.
The files are otherwise unchanged apart from `MapName`.

## Stitch region entity

```jsonc
{ "Type": "Vách", "ViaName": "…", "BlockName": "…", "IsStitchRegion": true, "IsClosed": true,
  "StitchZMin": -340, "StitchZMax": -100,           // optional: Z-band mode
  "FlattenedVertices": [[x, y, z], …] }             // polygon mode: region outline (convex hull is used)
```

It must share `ViaName`, `BlockName` and `Type` with the surface it applies to. In band mode the vertices
are only drawn; the band's lowest and highest contours become the seams and must end on boundary
vertices. The group needs exactly one boundary. Groups with holes, breaklines or scatter points fall back
to plain CGAL.

## Checking the results

```
npm start                        # server on :3001
node samples/hybrid/check.mjs    # runs both files through the app's parser + mesher
```

Expected output:

```
hybrid_test1_circle.json
  CGAL Mesh    vach   111 tris (plain CGAL), open loops 1, non-manifold 0
  CGAL Mesh    tru     92 tris (plain CGAL), open loops 1, non-manifold 0
  Hybrid Mesh  vach   321 tris (stitch 128 + CGAL 193, polygon), seam 96/96 shared, overhang 0, open loops 1, non-manifold 0
  Hybrid Mesh  tru     92 tris (plain CGAL), open loops 1, non-manifold 0

hybrid_test2_3_band_crossing.json
  CGAL Mesh    vach   532 tris (plain CGAL), open loops 1, non-manifold 0
  CGAL Mesh    tru    532 tris (plain CGAL), open loops 1, non-manifold 0
[Hybrid] The stitch covers 97.1% of the band — the boundary runs past its outermost contours there.
  Hybrid Mesh  vach  1088 tris (stitch 963 + CGAL 125, band), seam 14/14 shared, overhang 13, open loops 1, non-manifold 0
  Hybrid Mesh  tru    828 tris (stitch 229 + CGAL 599, polygon), seam 119/119 shared, overhang 17, open loops 1, non-manifold 0
```

What the output shows:
- **Open loops 1:** the only open edge is the outer boundary, so the seams have no gaps.
- **Seam n/n shared:** every seam segment is used by one stitch triangle and one CGAL triangle.
- **Overhang:** triangles facing down after consistent orientation. In Trụ these are the 3D fold where
  -150 passes over -160, which CDT (one Z per XY) can't build. In the Vách band they come from the
  stitcher pairing the long -120 contour with the short -100 one.
- **97.1% warning:** the stitcher leaves the shallow end of the band empty where the boundary runs flat
  beyond the last contour (the -100 cap and the -120 strip). This is a limit of the stitcher, not of the join.
- **Plain CGAL Trụ:** before the `mesh_gen` fix on this branch, CGAL gave the two crossing vertices Z = 0
  and the slope filter deleted 4 triangles around them (528 tris, 2 open loops). CGAL now interpolates
  their Z.
