document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('.glass-card').forEach(card => {
    const video = card.querySelector('.preview-video');

    if (video) {
      // Desktop: Hover play
      card.addEventListener('mouseenter', () => {
        if (!isTouchDevice()) {
          video.currentTime = 0;
          video.play();
        }
      });

      card.addEventListener('mouseleave', () => {
        if (!isTouchDevice()) {
          video.pause();
          video.currentTime = 0;
        }
      });

      // Mobile: Tap toggle
      let playing = false;
      card.addEventListener('click', () => {
        if (isTouchDevice()) {
          if (!playing) {
            video.currentTime = 0;
            video.play();
            playing = true;
          } else {
            video.pause();
            video.currentTime = 0;
            playing = false;
          }
        }
      });
    }
  });

  function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }
});
