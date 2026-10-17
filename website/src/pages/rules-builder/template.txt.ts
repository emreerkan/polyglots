import type { APIRoute } from 'astro';
import { rulesTemplate } from '../../lib/rules-template';

// The template the rules builder's agent prompt tells an agent to fetch.
// Named .txt, not .yaml: the web server has no type for .yaml and would serve
// it as a download, where .txt opens as text in a browser and in a fetch.
export const GET: APIRoute = () => new Response(rulesTemplate(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
