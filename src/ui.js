// ============================================================
// src/ui.js — DOM bits. No framework: an Activity is a single page that must
// boot fast inside an iframe, and 16 MB of wasm is already the heavy part.
//
// Discord hands us arbitrary user strings (names, nicknames, chat) with no
// sanitising, and its own docs say so. So every render path here goes through
// textContent / setAttribute — there is not one innerHTML assignment below that
// takes external data.
// ============================================================

import { GROUPS, MODES, modeById } from './protocol.js';
import { avatarUrl, displayName, userColor, dc } from './discord.js';

export const el = (id) => document.getElementById(id);
export const show = (node, on = true) => { if (node) node.hidden = !on; };

/** True while the caret is in a text field — the game must not eat those keys. */
export const isTyping = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};

export function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
}

/** Avatar that degrades to a coloured initial when the CDN is unreachable. */
export function avatar(user, size = 32, name) {
    const wrap = h('span', 'ava');
    wrap.style.setProperty('--ring', userColor(user || {}));
    const img = h('img');
    const label = (name || displayName(user || {}, '?')).slice(0, 1).toUpperCase();
    const url = avatarUrl(user || {}, size, dc.cdnHost);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.remove(); wrap.classList.add('fb'); wrap.appendChild(h('i', null, label)); };
    if (url) img.src = url; else { wrap.classList.add('fb'); wrap.appendChild(h('i', null, label)); }
    wrap.appendChild(img);
    return wrap;
}

// ── header chips ───────────────────────────────────────────────────────
export function chip(node, { text, tone, title }) {
    if (!node) return;
    node.textContent = text;
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
    if (title != null) node.title = title;
}

// ── roster ─────────────────────────────────────────────────────────────
/**
 * @param {HTMLElement} list
 * @param {Array<{cid,name,user,host,ready,watching,bits,role,isMe,talking}>} rows
 */
export function renderRoster(list, rows, opts = {}) {
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const r of rows) {
        const li = h('li', 'pl' + (r.host ? ' is-host' : '') + (r.isMe ? ' is-me' : '')
            + (r.onlyDiscord ? ' dc-only' : ''));
        li.appendChild(avatar(r.user, 40, r.name));

        const body = h('div', 'pl-body');
        const nm = h('div', 'pl-name');
        nm.appendChild(h('span', null, r.name));
        if (r.isMe) nm.appendChild(h('em', 'you', 'you'));
        if (r.host) nm.appendChild(h('em', 'host', '👑 host'));
        body.appendChild(nm);

        const meta = h('div', 'pl-meta');
        const role = r.role;
        if (role) {
            const tag = h('span', 'role', `${role.icon || ''} ${role.label}`);
            tag.title = role.hint || '';
            meta.appendChild(tag);
        }
        if (r.onlyDiscord) meta.appendChild(h('span', 'fine', 'in the activity, not in this game'));
        else if (!r.ready) meta.appendChild(h('span', 'warn', r.isMe ? 'starting game…' : 'loading'));
        if (r.watching) meta.appendChild(h('span', 'watch', '👀 watching'));
        if (r.talking) meta.appendChild(h('span', 'talking', '🎙'));
        if (r.ping != null) meta.appendChild(h('span', 'ping', `${r.ping}ms`));
        body.appendChild(meta);
        li.appendChild(body);

        // One action per row: hand over the session, or ask to watch.
        const btn = h('button', 'pl-act');
        btn.type = 'button';
        if (opts.canManage && !r.host && r.ready) {
            btn.textContent = 'make host';
            btn.title = 'Move this session onto their engine (their save file becomes the session)';
            btn.onclick = () => opts.onMakeHost?.(r);
        } else if (r.isMe && !r.host) {
            btn.textContent = 'host instead';
            btn.title = 'Take the session onto your engine';
            btn.onclick = () => opts.onMakeHost?.(r);
        } else if (r.ready && !r.isMe) {
            btn.textContent = r.watching ? 'unwatch' : 'watch';
            btn.title = 'Ask the host to stream their screen to you';
        }
        if (btn.textContent) li.appendChild(btn);

        // input pulse: a tiny live bar so "nobody is pressing anything" is obvious
        const pulse = h('span', 'pulse');
        const bits = r.bits || 0;
        pulse.dataset.on = bits ? '1' : '0';
        pulse.title = bits ? maskLabel(bits) : 'idle';
        li.appendChild(pulse);
        frag.appendChild(li);
    }
    list.appendChild(frag);
}

export function maskLabel(bits) {
    const names = [];
    if (bits & 1) names.push('↑');
    if (bits & 2) names.push('↓');
    if (bits & 4) names.push('←');
    if (bits & 8) names.push('→');
    if (bits & 16) names.push('A');
    if (bits & 32) names.push('B');
    if (bits & 64) names.push('Z');
    if (bits & 128) names.push('Start');
    return names.join(' ') || 'idle';
}

// ── mode bar ───────────────────────────────────────────────────────────
export function renderModes(bar, current, { canHost, onPick, onVote }) {
    if (!bar) return;
    const may = typeof canHost === 'function' ? canHost() : !!canHost;
    bar.replaceChildren();
    for (const m of MODES) {
        const b = h('button', 'mode' + (m.id === current ? ' on' : ''));
        b.type = 'button';
        b.textContent = `${m.icon} ${m.label}`;
        b.title = m.desc + (may ? '' : ' — you can call a vote for this');
        b.onclick = () => (may ? onPick(m.id) : onVote(m.id));
        if (!may) b.dataset.vote = '1';
        bar.appendChild(b);
    }
}

// ── co-op group legend ─────────────────────────────────────────────────
/**
 * @param {Map<string,string>} ownerByGroup  group id → cid of whoever holds it
 */
export function renderGroups(bar, ownerByGroup, playersById, localCid) {
    if (!bar) return;
    bar.replaceChildren();
    for (const g of GROUPS) {
        const owner = playersById.get(ownerByGroup.get(g.id));
        const item = h('div', 'grp');
        item.appendChild(h('b', null, `${g.icon} ${g.label}`));
        item.appendChild(h('span', null, owner ? (owner.name || 'player') : 'nobody yet'));
        item.appendChild(h('i', 'hint', g.hint));
        if (owner?.cid === localCid) item.classList.add('mine');
        if (!owner) item.classList.add('open');
        bar.appendChild(item);
    }
}

// ── chat ───────────────────────────────────────────────────────────────
export function pushChat(list, { name, text, kind, self }) {
    const row = h('div', 'msg' + (kind ? ` ${kind}` : '') + (self ? ' self' : ''));
    if (name) row.appendChild(h('b', 'who', name));
    row.appendChild(h('span', 'txt', text));
    list.appendChild(row);
    while (list.children.length > 120) list.firstChild.remove();
    const box = list.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
    return row;
}

// ── votes ──────────────────────────────────────────────────────────────
export function renderVote(box, vote, { onBallot, meCid }) {
    box.replaceChildren();
    box.hidden = !vote;
    if (!vote) return;
    const m = modeById(vote.value);
    const label = vote.kind === 'mode' ? `${m.icon} switch to “${m.label}”` : `${vote.kind}: ${vote.value}`;
    box.appendChild(h('div', 'vq', label));
    const need = vote.need || 2;
    const yes = (vote.yes || []).length, no = (vote.no || []).length;
    box.appendChild(h('div', 'vt', `yes ${yes}/${need} · no ${no}`));
    const row = h('div', 'vbtns');
    const y = h('button', 'yes', '👍 yes');
    const n = h('button', 'no', '👎 no');
    y.onclick = () => onBallot(true);
    n.onclick = () => onBallot(false);
    if ((vote.yes || []).includes(meCid)) y.classList.add('on');
    if ((vote.no || []).includes(meCid)) n.classList.add('on');
    const left = Math.max(0, Math.ceil(((vote.endsAt || 0) - Date.now()) / 1000));
    box.appendChild(h('div', 'vc', `${left}s left · called by ${vote.name || 'a player'}`));
    row.append(y, n);
    box.appendChild(row);
}

// ── toasts ─────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(text, tone = 'info', ttl = 3800) {
    const box = el('toasts');
    if (!box) return;
    const t = h('div', `toast ${tone}`, text);
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.remove('in');
        setTimeout(() => t.remove(), 400);
    }, ttl);
    return t;
}

// ── loading screen ─────────────────────────────────────────────────────
export function setLoading(pct, msg) {
    const bar = el('load-bar'), m = el('load-msg'), s = el('loading');
    if (!s) return;
    if (msg != null) m.textContent = msg;
    if (pct != null) bar.style.width = `${Math.round(pct * 100)}%`;
}
export function hideLoading() {
    const s = el('loading');
    if (!s || s.classList.contains('gone')) return;
    s.classList.add('gone');
    setTimeout(() => s.remove(), 700);
}

export { GROUPS, MODES };
