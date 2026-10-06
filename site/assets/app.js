// Click a screenshot to see it full size; Esc or a click closes it.
(() => {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.hidden = true;
  box.innerHTML = "<img alt=\"\">";
  document.body.appendChild(box);
  const img = box.querySelector("img");
  document.addEventListener("click", (e) => {
    const shot = e.target.closest("img.shot");
    if (shot) { img.src = shot.src; img.alt = shot.alt; box.hidden = false; return; }
    if (!box.hidden) box.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") box.hidden = true; });
})();
