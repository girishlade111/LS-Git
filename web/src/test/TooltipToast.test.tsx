/* Base element styles — everything token-driven, no raw values. */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  background: var(--ls-bg);
  color: var(--ls-text);
  font-family: var(--ls-font-ui);
  font-size: var(--ls-fs-body);
  line-height: var(--ls-lh-body);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  font-size: var(--ls-fs-h1);
  font-weight: 600;
  line-height: var(--ls-lh-tight);
}

button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
}

a {
  color: var(--ls-accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

ul,
ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

:focus-visible {
  outline: none;
  box-shadow: var(--ls-focus-ring);
  border-radius: var(--ls-radius-sm);
}

/* Screen-reader-only helper */
.ls-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
