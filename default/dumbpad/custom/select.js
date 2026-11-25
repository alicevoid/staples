// Notepad picker. Firefox cannot style a native <select> popup, so this draws its own list
// and drives the hidden select. app.js keeps using the select unchanged.
const select = document.getElementById('notepad-selector');

const picker = document.createElement('div');
picker.className = 'pad-select';
const button = document.createElement('button');
button.type = 'button';
button.className = 'pad-select-button';
button.setAttribute('aria-haspopup', 'listbox');
button.setAttribute('aria-expanded', 'false');
const list = document.createElement('ul');
list.className = 'pad-select-list';
list.setAttribute('role', 'listbox');
list.hidden = true;
picker.append(button, list);

// app.js sets up tooltips after this module runs, so the button inherits the select's
for (const attr of ['data-tooltip', 'data-shortcuts']) {
    button.setAttribute(attr, select.getAttribute(attr));
    select.removeAttribute(attr);
}
select.hidden = true;
select.after(picker);

let active = -1;

function render() {
    const current = select.options[select.selectedIndex];
    button.textContent = current ? current.textContent : '';
    button.title = button.textContent;
}

function renderList() {
    list.replaceChildren(...[...select.options].map((opt, i) => {
        const li = document.createElement('li');
        li.textContent = opt.textContent;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === select.selectedIndex));
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => choose(i));
        return li;
    }));
}

function highlight(i) {
    const items = list.children;
    if (!items.length) return;
    active = (i + items.length) % items.length;
    [...items].forEach((li, n) => li.classList.toggle('active', n === active));
    items[active].scrollIntoView({ block: 'nearest' });
}

function open() {
    renderList();
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    highlight(select.selectedIndex);
}

function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
}

function choose(i) {
    close();
    button.focus();
    if (i === select.selectedIndex) return;
    select.selectedIndex = i;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

button.addEventListener('click', () => (list.hidden ? open() : close()));
button.addEventListener('keydown', (e) => {
    if (list.hidden) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
        return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') close();
});
document.addEventListener('click', (e) => { if (!picker.contains(e.target)) close(); });

// app.js rebuilds the options on load, create, rename and delete
new MutationObserver(() => { render(); if (!list.hidden) renderList(); })
    .observe(select, { childList: true, subtree: true, characterData: true, attributes: true });

// app.js also sets these directly, which fires no event
for (const prop of ['value', 'selectedIndex']) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
        get() { return native.get.call(this); },
        set(v) { native.set.call(this, v); render(); },
    });
}

render();
