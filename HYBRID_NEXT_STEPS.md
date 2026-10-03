# Hybrid mesher: status and next steps

Branch `hybrid-mesher` (off `CGAL_delaunay_for_simple_datasets`), not pushed.

## Where things stand

- **Hybrid Mesh button.** Z-stitches inside stitch regions and CGAL CDT everywhere else, welded into one
  mesh. The code is in [public/hybrid_mesher.js](public/hybrid_mesher.js), wired in through
  `buildCgalMesh(..., { hybrid: true })` in [public/cgal_mesher.js](public/cgal_mesher.js).
- **Region sources:**
  - an `IsStitchRegion` polygon (the stitch is clipped to it, and the cut edge becomes a CGAL `HOLE`);
  - an `IsStitchRegion` with `StitchZMin`/`StitchZMax` (a Z band whose end contours are the seams);
  - **strip mode (default when no region is drawn):** the contours cut the surface into strips, paired by
    the order of their ends along the boundary. Strips whose outline crosses itself in plan are stitched,
    the rest go to CGAL one strip at a time. Seams are contours. See `samples/hybrid/README.md`.
  - automatic capsules around contours that cross in plan (now only a fallback when strip mode can't
    read the data).
- **Why strips:** circling regions by hand doesn't scale. Folds that touch the boundary (test 4) or run
  along a long curved arm (test 5) can't be covered by a convex region.
- **`mesh_gen` fixes:** CDT crossing vertices get an interpolated Z instead of 0, and JSON output uses 17
  digits instead of 10. Both binaries (`cpp/build/Release`, `cpp/build-linux`) are rebuilt.
- **Samples and check:** [samples/hybrid/](samples/hybrid/) has two input files reproducing the three
  tests, plus `check.mjs`. Expected numbers are in its README.

Verify with `npm start`, then `node samples/hybrid/check.mjs`.

## To do, in rough order

0. **Strip mode: the stitch doesn't follow the boundary.** This is the open problem. The current code (this
   commit) is the version that looked right on screen; it still leaves seam gaps (42/1346 seam segments in
   test 5, 6/96 in test 4) because `uniformStitch` trims rail ends that run >150 m past the other rail and
   drops triangles under 0.0001 m².

   Tried on 2026-10-03 and reverted (commits removed, not pushed). Each fixed the numbers but looked wrong
   in the app:
   - **Trimming off, tiny-triangle drop off** (`uniformStitch` options `trimOverhang: false, minArea: 1e-9`).
     Seams closed on every sample, 0 non-manifold. But a rail that runs far past the other one is fanned to
     the other rail's end point: in test 5 the south-west lobe became one huge fan from a single point, and
     stitched triangles went 89k → 117k.
   - **No in-between rows** (`rows: false`, one row of triangles from contour to contour). Test 5 dropped to
     18.9k stitched triangles and 3.2k downward-facing, still 0 non-manifold, but the fans and the slanted
     strips past the boundary line stayed.
   - **Boundary arcs in rail 2** (so both rails start and end at the same points and the stitch has to follow
     the boundary). On test 5 the boundary is built from the contours' own points, so rail 2 runs along
     rail 1 for long stretches; the zero-length rungs give 10k non-manifold edges with rows, 85 without.
     Dropping just the two shared end points didn't help.
   - **CGAL in each folded strip's own best-fit plane.** Only 2 of 28 folded strips in test 5 are simple in
     that plane: the strips are nearly horizontal and the folds are local, so the plane is just XY.
   - Kept as an idea, not committed: skip strips with no area (where the boundary follows a contour point for
     point, e.g. D67 at 238 in test 5). Those 42 "gaps" in test 5 are really the outer edge.

   Root cause: `uniformStitch` only zips two polylines by XY distance. It has no notion of the strip's
   outline, so at a strip's ends it cuts straight across between the two contour ends instead of following
   the boundary. A real fix probably needs a stitcher that takes the whole strip outline (contours + boundary
   arcs, with stretches where the boundary coincides with a contour removed first) and triangulates inside it.

1. **Click through in the browser.** Load both sample files and press Hybrid Mesh. So far this was only
   checked by running the app's modules in Node against the real server. Check the amber and red
   rendering, the Vách/Trụ toggles, and triangle delete on a hybrid mesh.
2. **Recheck the "all fragmented" file** from yesterday on this branch. On other datasets the crossing-Z fix
   alone cut open loops a lot: `tn_tét.json` went from 20 to 5, and `Vỉa_2.json` Khối 1 from 5 to 2.
3. **Weld tolerance**, still 1e-4, and `mesh_endpoint.js` never passes `--weld-tol`. The exported data has
   many near-miss endpoints at 1e-4 to 1e-2 (e.g. `demo_DHTN.json` has about 15k pairs at 1e-4 to 1e-3). On
   `tn_tét.json`, 2e-3 cut slivers from 465 to 173. Decide on a default, or pass it per request.
4. **Gaps in the stitch band.** In test 2 the stitch covers only 97.1% of the Vách band: it doesn't reach the
   -100 cap or the flat -120 strip, where the boundary runs past the last contour. Option: give those
   areas to CGAL as extra polygons.
5. **Folds in the -120 → -100 strip** of test 2 (13 overhang triangles). The long -120 contour is paired
   with the short -100 one inside `uniformStitch`.
6. **Hybrid limitations to lift if needed** (these groups currently fall back to plain CGAL, with the
   reason logged in the console):
   - exactly one boundary per group;
   - no holes, breaklines or scatter points;
   - one Z band per group;
   - polygon regions are made convex (convex hull);
   - a band's seam contours must end on boundary vertices;
   - the crossing capsule half-width is a fixed 12 m, and the capsule must sit at least 0.5 m inside the
     boundary and on the stitched surface, or it is skipped.
7. **Fast Stitch cross-stitching.** The old Fast Stitch button (`mesh_generator.js`) ignores `featureType`,
   so on Vách + Trụ files it stitches Vách contours to Trụ contours at the same Z. This was found by
   reading the code, not by running it.
8. **Via Solid / Compute Volume on hybrid meshes: untested.** Overhang (downward-facing) triangles may
   affect border extraction or the signed volume.

## Background from the dry runs

- **Why a shared seam matters:** joining two separately built meshes only works if both sides have the
  same seam vertices. Contour seams (band mode) match exactly. Polygon seams need the contours cut at the
  polygon first, or CDT adds crossing vertices the stitch side lacks.
- **Test 1:** a single circle around the test 3 crossings would need a radius of at least 56 m and would
  cross the boundary, which is why crossings use a capsule instead.
- **Dry-run scripts and 3D viewers** lived in the session scratchpad and aren't in the repo. The viewers
  were published as private artifacts:
  - [test 1](https://claude.ai/artifact/YPB2VH9F1rQvew4R9toco2)
  - [test 2](https://claude.ai/artifact/5475wNeQf89LyqHrrsdFJA)
  - [test 3](https://claude.ai/artifact/7VEdWB5EB2Uhs7mzZ6rJHC)
