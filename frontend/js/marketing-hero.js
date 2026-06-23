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

(() => {
  const tabsWidget = document.querySelector('[data-journey-tabs]');
  if (!tabsWidget) return;

  const tabs = Array.from(tabsWidget.querySelectorAll('[role="tab"]'));
  const panels = Array.from(tabsWidget.querySelectorAll('[role="tabpanel"]'));

  const selectTab = (nextTab, moveFocus = false) => {
    tabs.forEach((tab) => {
      const isSelected = tab === nextTab;
      tab.classList.toggle('is-active', isSelected);
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    });

    panels.forEach((panel) => {
      panel.hidden = panel.id !== nextTab.getAttribute('aria-controls');
    });

    if (moveFocus) nextTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) nextIndex = (index + 1) % tabs.length;
      if (['ArrowLeft', 'ArrowUp'].includes(event.key)) nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectTab(tabs[nextIndex], true);
    });
  });
})();

(() => {
  const reel = document.querySelector('[data-video-reel]');
  if (!reel) return;

  const videos = Array.from(reel.querySelectorAll('.display-video'));
  if (videos.length < 2) return;

  let activeIndex = 0;
  let transitionTimer;

  const playNextVideo = () => {
    const previousVideo = videos[activeIndex];
    activeIndex = (activeIndex + 1) % videos.length;
    const nextVideo = videos[activeIndex];

    nextVideo.currentTime = 0;
    nextVideo.classList.add('is-active');
    previousVideo.classList.remove('is-active');
    nextVideo.play().catch(() => {});

    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => {
      previousVideo.pause();
      previousVideo.currentTime = 0;
    }, 850);
  };

  videos.forEach((video) => video.addEventListener('ended', playNextVideo));
})();
