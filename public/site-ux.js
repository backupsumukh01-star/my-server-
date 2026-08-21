(function () {
  const progress = document.querySelector('[data-scroll-progress]');
  const navbar = document.querySelector('.navbar');
  const scrollBox = document.querySelector('[data-page-scroll]');
  const navAnchors = Array.from(
    document.querySelectorAll('.navbar-nav .nav-link[href^="#"]')
  );
  const sections = ['how-it-works', 'features', 'rewards', 'faq']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function syncScrollButtons() {
    if (!scrollBox) return;

    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollBox.hidden = max <= 8;
    scrollBox.classList.toggle('at-top', window.scrollY <= 8);
    scrollBox.classList.toggle('at-bottom', window.scrollY >= max - 8);
    scrollBox
      .querySelector('[data-scroll="up"]')
      ?.toggleAttribute('disabled', window.scrollY <= 8);
    scrollBox
      .querySelector('[data-scroll="down"]')
      ?.toggleAttribute('disabled', window.scrollY >= max - 8);
  }

  function syncScrollSpy() {
    if (!sections.length || !navAnchors.length) return;

    const offset = (navbar?.offsetHeight || 72) + 24;
    const y = window.scrollY + offset;

    if (window.scrollY < 120) {
      navAnchors.forEach((link) => link.classList.remove('is-active-section'));
      return;
    }

    let current = sections[0];

    for (const section of sections) {
      if (section.offsetTop <= y) current = section;
    }

    navAnchors.forEach((link) => {
      const id = link.getAttribute('href')?.slice(1);
      link.classList.toggle('is-active-section', id === current.id);
    });
  }

  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;

    requestAnimationFrame(() => {
      const y = window.scrollY;
      const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);

      if (progress) {
        progress.style.setProperty('--progress', String(Math.min(1, y / max)));
      }

      navbar?.classList.toggle('is-scrolled', y > 16);
      scrollBox?.classList.toggle('is-visible', y > 240);

      syncScrollSpy();
      syncScrollButtons();
      ticking = false;
    });
  }

  document.addEventListener('click', function (event) {
    const button = event.target.closest('[data-scroll]');
    if (button) {
      const top =
        button.dataset.scroll === 'up' ? 0 : document.documentElement.scrollHeight;
      window.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
      return;
    }

    const anchor = event.target.closest('a[href^="#"]');
    if (!anchor || anchor.getAttribute('href') === '#') return;

    const target = document.querySelector(anchor.getAttribute('href'));
    if (!target) return;

    const collapse = document.getElementById('navbarNav');
    if (collapse?.classList.contains('show')) {
      collapse.classList.remove('show');
      document
        .querySelector('[data-bs-target="#navbarNav"]')
        ?.setAttribute('aria-expanded', 'false');
    }
  });

  if (!reducedMotion) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    );

    document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));
  } else {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
  }

  document.querySelectorAll('[data-tx-track]').forEach((track) => {
    const list = track.querySelector('[data-tx-list]');
    if (!list || track.querySelector('[data-tx-list-clone]')) return;
    const clone = list.cloneNode(true);
    clone.setAttribute('data-tx-list-clone', '');
    clone.setAttribute('aria-hidden', 'true');
    track.appendChild(clone);
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
})();
