import type { APIRoute } from 'astro';
import { WPORG_LOCALES } from '../../../../../app/src/wporg/locales';

// The locale slugs public/api/glossary/index.php accepts, one per line, built
// from the same list the editor's locale picker offers. Without it the script
// could only check a slug's shape, and every made-up slug that passed would
// cost wp.org a request and leave a lock file behind.
export const GET: APIRoute = () =>
  new Response([...new Set(WPORG_LOCALES.map((l) => l.slug))].join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
