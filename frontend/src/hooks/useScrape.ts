/**
 * Thin wrapper around ScrapeContext — all state is now persistent
 * across navigation via the context provider in layout.tsx.
 */
export { useScrapeContext as useScrape } from '../context/ScrapeContext';
