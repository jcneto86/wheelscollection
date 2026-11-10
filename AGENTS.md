# Wheels Collection Web — AI Agent Guidelines

This document guides AI assistants (OpenCode, Claude, etc.) on the architecture, conventions, and rules for developing and modifying this project.

## 1. Tech Stack & Architecture
- **Architecture:** Static SPA (Single Page Application) using Hash-based routing (`#/`). No server-side rendering or SSR framework.
- **Frontend Core:** Plain HTML5 (`index.html`), Alpine.js 3.x (ESM modules), and compiled Tailwind CSS (`css/tailwind.css`).
- **Backend / BaaS:** Firebase Auth (Email/Password) and Cloud Firestore (`hotwheels_items` collection).
- **Image Processing:** Browser-side Canvas cropping, exported strictly as 500x500 JPEG Base64 strings (without data prefix, stored directly in Firestore fields).
- **OCR Engine:** Client-side Tesseract.js (loaded on demand via CDN) for local packaging text extraction.
- **Localization:** Trilingual (`en-CA`, `fr-CA`, `pt-BR`) via JSON dictionaries in `lang/`.

---

## 2. Core Rules for AI Code Generation

1. **Keep it Vanilla & Modular:** Do not introduce heavy frontend frameworks (React, Vue, Angular, Vite build chains for app logic) unless explicitly requested. Maintain the separation between views in `index.html` and logic controllers in `js/`.
2. **Alpine.js Bindings:** Ensure all interactive components use proper Alpine directives (`x-data`, `x-show`, `x-for`, `x-model`, `@click`). Never manipulate the DOM directly via raw `document.getElementById` unless wrapping custom canvas or third-party integrations.
3. **Tailwind Styling & Compilation:** 
   - Classes must rely on Tailwind utility classes or custom CSS tokens defined in `css/styles.css`.
   - If adding brand-new custom Tailwind classes that require compilation, remind the user to run `npm run css`.
4. **Firestore Data Integrity:**
   - Always query documents bound to the authenticated user: `where('userId', '==', auth.currentUser.uid)`.
   - Respect the Firestore document limits (keep base64 image strings under 900,000 characters to stay safely below the 1 MiB document limit).
5. **Localization Compliance (`i18n`):**
   - **Never hardcode user-facing strings.** Every new label or message must use the translation helper `t('keyName')` and be added to all three dictionaries (`en-CA.json`, `fr-CA.json`, and `pt-BR.json`).
6. **Responsive Design:** 
   - Every UI component, card grid, or form must look polished on both mobile viewports (390px) and widescreen desktops (1440px+).

---

## 3. Project File Structure & Constraints
- `index.html`: Contains the entire SPA layout, views, templates, and modals.
- `js/controller.js`: Main Alpine application state and router controller.
- `js/app.js`: OCR pipeline integration and packaging parsers.
- `lang/`: Localization files (`en-CA.json`, `fr-CA.json`, `pt-BR.json`).
- `tools/`: Local CLI tooling (`wheels.mjs`, scripts). Do not publish these to production.

---

## 4. Common Tasks & Commands
- **Local Dev Server:** `npm run dev` or `node tools/wheels.mjs dev`
- **Project Validation:** `npm run check`
- **Recompile Tailwind:** `npm run css`
- **Build for Hostinger:** `npm run build` (outputs to `build/`)