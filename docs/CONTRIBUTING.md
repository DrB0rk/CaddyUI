# Contributing

Thanks for helping improve CaddyUI.

## Before you start

- Search existing [issues](https://github.com/DrB0rk/CaddyUI/issues) first.
- Open an issue for bugs, feature requests, or larger changes.
- Keep PRs focused and small where possible.

## Branch flow

- `dev` is the active development branch.
- Do not open feature work directly against `main`.
- Release flow is `dev` -> `beta` -> `main`.

## Local setup

```bash
git clone https://github.com/DrB0rk/CaddyUI
cd CaddyUI
npm install
npm run dev
```

## Pull requests

1. Fork the repository.
2. Create a branch from `dev`.
3. Make your changes.
4. Run:
   ```bash
   npm run build
   ```
5. Open a PR to `dev` and fill out the PR template.

Please follow [Conventional Commits](https://www.conventionalcommits.org/).
