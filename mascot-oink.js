// mascot-oink.js — the pig-mascot click behavior, shared by every page that
// shows one (index.html, about.html). Kept separate from app.js since that
// file is map/search-specific and pages without a map shouldn't load it.

document.querySelectorAll(".mascot-pig").forEach((pig) => {
  pig.addEventListener("click", (e) => {
    const wrap = pig.closest(".mascot-wrap");
    const bubble = wrap?.querySelector(".oink-bubble");
    if (!wrap || !bubble) return;

    const rect = wrap.getBoundingClientRect();
    bubble.style.left = `${e.clientX - rect.left}px`;
    bubble.style.top = `${e.clientY - rect.top}px`;

    bubble.classList.remove("show");
    // Force reflow so re-adding the class restarts the animation on rapid clicks.
    void bubble.offsetWidth;
    bubble.classList.add("show");
    clearTimeout(bubble._oinkTimeout);
    bubble._oinkTimeout = setTimeout(() => bubble.classList.remove("show"), 900);
  });
});
