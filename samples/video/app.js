// samples/video — the embeddable 3D video player.
//
// Two embeds on this page: the factory (below) and a <dxr-video-player> element
// in index.html. Both share ONE inline-3D session (the player module keeps a
// single createInline3D() for the whole document).

import { createVideoPlayer } from '@displayxr/inline3d/player';

const status = document.getElementById('status');

const player = createVideoPlayer(document.getElementById('host'), {
  src: '../windows/assets/flymetothemoon_sbs.webm',
  loop: true,
  muted: true,       // muted so it can autoplay; the mute button toggles it
  autoplay: false,   // start paused with a big play button
  cornerRadius: 16,
});

// The player flips the host's data-dxr3d to "on" once a 3D session is acquired.
// Poll once after a tick to report which mode this browser gave us.
setTimeout(() => {
  const on = player.el.getAttribute('data-dxr3d') === 'on';
  status.textContent = on
    ? '✅ DisplayXR Browser — weaving glasses-free 3D. Play, loop, scrub, and go fullscreen.'
    : 'ℹ️ Not a DisplayXR Browser — showing the left eye as a normal 2D video (same controls). '
      + 'Open in the DisplayXR Browser on 3D hardware to see it in 3D.';
  status.style.background = on ? '#12331e' : '#1b1b24';
}, 400);

// Expose for console tinkering.
window.dxrPlayer = player;
