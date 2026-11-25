// Header dog for paste.pvc.tools. Static by default; the Settings toggle turns the animation on.
// The choice is per browser (localStorage). The animator is pvc.dog's, compiled to ascii_animator.js.
import { AsciiAnimator, TICK_INTERVAL_MS } from './ascii_animator.js';

const KEY = 'paste_animate_dog';
const STATIC_DOG = '[UO\\.0U]., ~#';

const title = document.getElementById('header-title');
const toggle = document.getElementById('settings-animate-dog');
const animator = new AsciiAnimator();
let timer = null;

function load() {
    try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

function save(on) {
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: not saved */ }
}

function start() {
    if (timer) return;
    timer = setInterval(() => {
        animator.tick();
        title.textContent = animator.currentFrame;
    }, TICK_INTERVAL_MS);
}

function stop() {
    clearInterval(timer);
    timer = null;
    title.textContent = STATIC_DOG;
}

function apply(on) {
    on ? start() : stop();
}

toggle.checked = load();
apply(toggle.checked);
toggle.addEventListener('change', () => {
    save(toggle.checked);
    apply(toggle.checked);
});
