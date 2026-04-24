/**
 * DOM helpers — hyperscript pattern, sanitization, formatting.
 * No innerHTML anywhere. All rendering via createElement + textContent.
 */
import { shortenAddress } from './squads.js';
import { getExplorerUrl } from './state.js';

// Unicode bidi override characters that can spoof displayed addresses
const BIDI_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Core DOM builder — hyperscript pattern.
 */
const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'multiple', 'autofocus']);

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      e[k] = v;
    } else if (k === 'className') {
      e.className = v;
    } else if (BOOL_ATTRS.has(k)) {
      if (v) e.setAttribute(k, '');
      // false → don't set the attribute at all
    } else {
      e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

/**
 * Sanitize on-chain strings: strip Unicode bidi override characters.
 */
export function sanitize(str) {
  return String(str).replace(BIDI_REGEX, '');
}

/**
 * Create a clickable address with copy + explorer link.
 */
export function addrEl(pubkey, { short = true, explorer = true } = {}) {
  const clean = sanitize(pubkey);
  const display = short ? shortenAddress(clean) : clean;

  const container = el('span', { className: 'flex gap-sm' });

  if (explorer) {
    const link = el('a', {
      className: 'addr',
      href: getExplorerUrl('account', clean),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: clean,
    }, display);
    container.appendChild(link);
  } else {
    container.appendChild(el('span', { className: 'addr', title: clean }, display));
  }

  const copyBtn = el('button', {
    className: 'copy-btn',
    title: 'Copy address',
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(clean).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    },
  }, 'Copy');
  container.appendChild(copyBtn);

  return container;
}

/**
 * Format SOL amount from lamports.
 */
export function formatSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4) + ' SOL';
}

/**
 * Format a BigInt or number with commas.
 */
export function formatNumber(n) {
  return Number(n).toLocaleString();
}

/**
 * Format a timestamp (i64 seconds since epoch) to local date string.
 */
export function formatTimestamp(ts) {
  if (!ts) return '';
  const ms = Number(ts) * 1000;
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Status indicator — small dot + label.
 */
export function statusBadge(status) {
  const classMap = {
    Draft: 'status--draft',
    Active: 'status--active',
    Approved: 'status--approved',
    Rejected: 'status--rejected',
    Executed: 'status--executed',
    Executing: 'status--active',
    Cancelled: 'status--cancelled',
  };
  const cls = classMap[status.name] || 'status--executed';
  const container = el('span', { className: `status ${cls}` });
  container.appendChild(el('span', { className: 'status-dot' }));
  container.appendChild(el('span', {}, status.name));
  return container;
}

/**
 * Build a DocumentFragment from an array of elements (batch DOM writes).
 */
export function fragment(...elements) {
  const frag = document.createDocumentFragment();
  for (const e of elements) {
    if (e) frag.appendChild(e);
  }
  return frag;
}
