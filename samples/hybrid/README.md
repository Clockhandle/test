# Hybrid mesh samples

Four input files for the **Hybrid Mesh** button. They reproduce the hybrid tests: z-stitch where CGAL's
2.5D triangulation can't represent the surface, CGAL CDT everywhere else, both welded into one mesh along a
shared seam. Upload any of them in the app, then press **Hybrid Mesh**. Stitched triangles are amber and
seams are red. Press **CGAL Mesh** to compare.

| File | Test | Surface | How the stitch region is chosen |
|---|---|---|---|
| `hybrid_test1_circle.json` | 1: circle | Vách | `IsStitchRegion` polygon: a 20 m circle over the middle of the Vách. Inside it is z-stitched; outside, CGAL uses the cut edge as a hole. |
| `hybrid_test2_3_band_crossing.json` | 2: contour split | Vách | `IsStitchRegion` with `StitchZMin: -340`, `StitchZMax: -100`. Contours in that band are stitched. The hooked -380 contour and the curved border below -340 go to CGAL, with the -340 contour as the seam. |
| `hybrid_test2_3_band_crossing.json` | 3: crossings | Trụ | Automatic (strip mode). The -150 contour crosses -160 twice in plan, so the strip between them is z-stitched; every other strip goes to CGAL. |
| `hybrid_test4_twisting_lines.json` | 4: boundary crosses itself | Vách | Automatic (strip mode). The boundary runs in and out along a thin slit and crosses itself; contours cross the boundary 10 times. Each side of the fold is its own strip, so most of it stays CGAL. |
| `hybrid_test5_vach_tru_hep.json` | 5: overturned wall | Vách | Automatic (strip mode). 484 contour crossings in plan: a fold in the middle and a near-vertical narrow east arm. 28 of 71 strips are z-stitched. |

Test 1 uses `Via_test.json` plus the circle entity. Tests 2 and 3 use `via_test_3.json` plus the band entity;
those files are otherwise unchanged apart from `MapName`. Tests 4 and 5 are `test_case_twisting_lines.json` and
`BD_Vach_Tru_Hep.json`, unchanged.

## Strip mode (no region drawn)

When a group has no `IsStitchRegion`, the hybrid mesher works the regions out by itself:

1. Contours that run from boundary to boundary cut the surface into strips. Contours are paired by the order
   their ends sit along the boundary, not by distance in plan, so the two sides of a fold stay apart. Ends up
   to 3 m from the boundary are snapped onto it.
2. A strip whose outline crosses itself in plan is a fold and is z-stitched. Every other strip is meshed by
   CGAL on its own (slope filter off, so steep strips are kept).
3. Neighbouring strips share whole contours, so every seam is a contour and nothing is clipped.

Left out, with a console warning: contours that don't end on the boundary and aren't closed loops (e.g.
2-point pieces), and contours whose Z is far from the boundary Z at both ends (e.g. the Z 0 line inside the
121–147 band in test 5). Closed loops (pits and peaks) go to CGAL as contours. If no contour runs boundary
to boundary, the mesher falls back to the old capsules around crossings.

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
  Hybrid Mesh  tru    600 tris (stitch 29 + CGAL 571, strip), seam 29/29 shared, overhang 17, open loops 1, non-manifold 0

hybrid_test4_twisting_lines.json
  CGAL Mesh    vach  1460 tris (plain CGAL), open loops 1, non-manifold 0
[Hybrid] 6 of 96 seam segments are not shared by both sides — the seam has gaps.
  Hybrid Mesh  vach  2311 tris (stitch 846 + CGAL 1466, strip), seam 90/96 shared, overhang 0, open loops 1, non-manifold 0

hybrid_test5_vach_tru_hep.json
  CGAL Mesh    vach 24394 tris (plain CGAL), open loops 116, non-manifold 0
[Hybrid] Strip mode left out 3 contour(s): …
[Hybrid] 42 of 1346 seam segments are not shared by both sides — the seam has gaps.
  Hybrid Mesh  vach 99291 tris (stitch 89271 + CGAL 10020, strip), seam 1304/1346 shared, overhang 13846, open loops 1, non-manifold 0
```

What the output shows:
- **Open loops 1:** the only open edge is the outer boundary, so the seams have no gaps.
- **Seam gaps in tests 4 and 5:** `uniformStitch` trims a contour's end when it runs more than 150 m past
  the other contour, and drops near-flat triangles; the strip next to it then has a gap along that stretch.
- **Seam n/n shared:** every seam segment is used by one stitch triangle and one CGAL triangle.
- **Overhang:** triangles facing down after consistent orientation. In Trụ these are the 3D fold where
  -150 passes over -160, which CDT (one Z per XY) can't build. In the Vách band they come from the
  stitcher pairing the long -120 contour with the short -100 one.
- **97.1% warning:** the stitcher leaves the shallow end of the band empty where the boundary runs flat
  beyond the last contour (the -100 cap and the -120 strip). This is a limit of the stitcher, not of the join.
- **Plain CGAL Trụ:** before the `mesh_gen` fix on this branch, CGAL gave the two crossing vertices Z = 0
  and the slope filter deleted 4 triangles around them (528 tris, 2 open loops). CGAL now interpolates
  their Z.
