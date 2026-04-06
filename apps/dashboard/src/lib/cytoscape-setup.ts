import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';

let registered = false;

export function ensureDagreRegistered(): void {
  if (registered) return;
  try {
    cytoscapeDagre(cytoscape);
  } catch {
    // already registered (e.g. HMR reload)
  }
  registered = true;
}

export { cytoscape };
