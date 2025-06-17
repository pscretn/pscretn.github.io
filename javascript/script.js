document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('.glass-card').forEach(card => {
    const video = card.querySelector('.preview-video');

    if (video) {
      card.addEventListener('mouseenter', () => {
        video.currentTime = 0;
        video.play();
      });

      card.addEventListener('mouseleave', () => {
        video.pause();
        video.currentTime = 0;
      });
    }
  });
});
