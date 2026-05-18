import * as THREE from 'three';

/**
 * Vach / Tru visibility toggles.
 *
 * Walks meshGroup recursively each time a button is clicked and flips
 * `visible` on every object whose userData.featureType matches.
 * We re-walk on every click rather than caching, because new lines/meshes
 * are added after Stitch and after each file load.
 */
const state = {
  vach: true,
  tru: true,
};

export function setupTypeToggles(scene) {
  const vachBtn = document.getElementById('toggle-vach-btn');
  const truBtn = document.getElementById('toggle-tru-btn');
  if (!vachBtn || !truBtn) return;

  const apply = () => {
    const meshGroup = scene.userData.meshGroup;
    if (!meshGroup) return;
    meshGroup.traverse(obj => {
      const t = obj.userData && obj.userData.featureType;
      if (t === 'vach') obj.visible = state.vach;
      else if (t === 'tru') obj.visible = state.tru;
    });
  };

  const refreshLabels = () => {
    vachBtn.innerText = `Vách: ${state.vach ? 'On' : 'Off'}`;
    vachBtn.style.background = state.vach ? '#17a2b8' : '#6c757d';
    truBtn.innerText = `Trụ: ${state.tru ? 'On' : 'Off'}`;
    truBtn.style.background = state.tru ? '#fd7e14' : '#6c757d';
  };

  vachBtn.addEventListener('click', () => {
    state.vach = !state.vach;
    refreshLabels();
    apply();
  });

  truBtn.addEventListener('click', () => {
    state.tru = !state.tru;
    refreshLabels();
    apply();
  });

  // Re-apply after Stitch / CGAL mesh so newly added objects obey current state.
  const stitchBtn = document.getElementById('stitch-mesh-btn');
  if (stitchBtn) {
    stitchBtn.addEventListener('click', () => { setTimeout(apply, 0); });
  }
  const cgalBtn = document.getElementById('cgal-mesh-btn');
  if (cgalBtn) {
    // CGAL mesh is async; poll briefly until the new group appears.
    cgalBtn.addEventListener('click', () => {
      let attempts = 0;
      const poll = () => { apply(); if (++attempts < 20) setTimeout(poll, 250); };
      setTimeout(poll, 500);
    });
  }

  refreshLabels();
}
