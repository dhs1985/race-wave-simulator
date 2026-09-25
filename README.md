# Two Bays Trail Run Results Visualizer

This website lets you view and explore the results of the Two Bays Trail Run. It shows all runners on a map and elevation profile, animating their progress along the course. You can filter by wave, gender, or category, and see how each runner moves through the race.

How it works:
- The site loads official race data (CSV files) and course tracks (GPX files).
- Runners are shown as colored dots moving along the trail, grouped by their starting wave.
- You can play, pause, and adjust the speed of the animation.
- The map and elevation views help you see where runners are at any point in the race.
- Filtering options let you focus on specific groups or individuals.

No account or login is needed. All data is public and updated for the 2026 event.

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:


## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Project Overview
Project scaffolded with Vite + React
Node.js upgraded and dev server running
Dependencies for CSV and GPX parsing installed
File parsing and visualization implemented

## Tidy-up Checklist Before Uploading to GitHub
- Remove any debug logs or test code from src/App.jsx
- Ensure all sensitive data is excluded (no secrets, passwords, or private info)
- Clean up unused files or scripts
- Verify package.json has correct project name, description, and author
- Run `npm run build` to confirm the app builds successfully
- Update this README with build and deploy instructions

## Build Instructions
1. Install dependencies:
	```sh
	npm install
	```
2. Build the static site:
	```sh
	npm run build
	```
	The output will be in the `dist` folder.

## Deploy to GitHub Pages
1. Push your project to a GitHub repository.
2. Use a tool like [vite-plugin-gh-pages](https://github.com/tschaub/gh-pages) or manually upload the `dist` folder to the `gh-pages` branch.
3. In your `vite.config.js`, set the `base` option to your repo name (e.g., `/TBTR_Web/`).
4. Enable GitHub Pages in your repo settings, pointing to the `gh-pages` branch.
5. Your site will be live at `https://<username>.github.io/<repo>/`.

## Notes
- For high initial traffic, GitHub Pages should suffice for static content. If you need more scalability or custom domains, consider Netlify, Vercel, or Cloudflare Pages.
