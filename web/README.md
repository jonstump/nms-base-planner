# web

The React + TypeScript view layer.

Governing: [ADR-0004](../docs/adrs/ADR-0004-react-view-layer.md),
[SPEC-0005](../docs/openspec/specs/view-foundations/spec.md).

## Commands

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Vite dev server                                          |
| `npm run build`        | Typecheck, then production build to `dist/`              |
| `npm run preview`      | Serve `dist/` with the deployment's CSP applied          |
| `npm run typecheck`    | `tsc` with no emit                                       |
| `npm run lint`         | ESLint over `.ts`/`.tsx`                                 |
| `npm run lint:css`     | Stylelint over `src/**/*.css`                            |
| `npm run check:tokens` | Colour literals outside the token file, including `.tsx` |
| `npm run format:check` | Prettier check                                           |

All of these run in CI as separate jobs.

## The token file

`src/styles/tokens.css` is the only file permitted to contain a colour
literal. Every value in it is recreated from
[`docs/design/theme/handoff.md`](../docs/design/theme/handoff.md), and the
contrast figures in its comments are the design reference's own measurements.

Two things enforce this rather than leaving it to review: stylelint's
`color-no-hex`, scoped to exempt the token file, and `check:tokens`, which
also covers `.ts`/`.tsx` where an inline style could carry a literal and
stylelint does not look.

If a component needs a value the token file does not define, add it to the
token file with its design provenance — do not write it inline.

## Fonts

The token file names Chakra Petch, Space Grotesk and JetBrains Mono, and each
stack falls back to a system face of similar character. **No webfont is
loaded yet.** The CSP restricts `font-src` to the origin, so shipping these
means self-hosting the files; that decision has not been made and is not part
of the scaffolding story.

## Content Security Policy

The policy lives in two places, with the same value:

- `vite.config.ts` — applied to `vite preview`, which serves the real build
- `public/_headers` — the artifact a static host reads

It is deliberately **not** applied to `vite dev`: the dev server injects an
inline HMR client, and a policy forbidding inline script would break the
thing it protects and teach everyone to disable it. Dev is not a deployment.

`build.modulePreload.polyfill` is off because Vite injects that polyfill as
an inline script. A CI step asserts the built HTML contains no inline script,
so the policy is checked against the output rather than merely declared.
