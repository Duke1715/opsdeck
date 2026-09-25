export function mountPlaceholder(el: HTMLElement, title: string, text: string) {
  el.innerHTML = `<div class="page"><h2></h2><p class="muted"></p></div>`;
  el.querySelector("h2")!.textContent = title;
  el.querySelector("p")!.textContent = text;
}
