(() => {
  const slideshow = document.querySelector('[data-hero-slideshow]');
  if (!slideshow || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const slides = Array.from(slideshow.querySelectorAll('.showcase-slide'));
  if (slides.length < 2) return;

  let activeIndex = 0;
  window.setInterval(() => {
    const previousSlide = slides[activeIndex];
    activeIndex = (activeIndex + 1) % slides.length;
    const nextSlide = slides[activeIndex];

    previousSlide.classList.remove('is-active');
    previousSlide.setAttribute('aria-hidden', 'true');
    nextSlide.classList.add('is-active');
    nextSlide.removeAttribute('aria-hidden');
  }, 5000);
})();
