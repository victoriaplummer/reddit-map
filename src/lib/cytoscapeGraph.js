import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import bus from '../bus';
import redditDataClient from './redditDataClient';

cytoscape.use(fcose);

const HIGHLIGHT_COLOR = '#1DA1F3';

// Tunable settings — exposed via getSettings/updateSettings
let settings = {
  initialDepth: 2,
  dragPullStrength: 0.35,
  edgeWeightCutoff: 2.5,
};

let cy = null;
let depthMap = new Map();
let currentRoot = ''; // the search query that built this graph

// Drag-pull state
let grabOrigin = null;
let neighborOrigins = null;

// Spotlight state
let spotlightActive = false;

const style = [
  {
    selector: 'node',
    style: {
      'label': 'data(id)',
      'text-valign': 'center',
      'text-halign': 'center',
      'shape': 'round-rectangle',
      'background-color': '#fff',
      'border-color': '#aaa',
      'border-width': (ele) => Math.max(1, ele.data('size') * 4 + 1),
      'width': (ele) => {
        const fontSize = ele.data('size') * 24 + 12;
        return ele.data('id').length * fontSize * 0.6 + fontSize * 3;
      },
      'height': (ele) => {
        const fontSize = ele.data('size') * 24 + 12;
        return fontSize * 1.6;
      },
      'font-size': (ele) => ele.data('size') * 24 + 12,
      'font-family': '"Roboto", arial, sans-serif',
      'color': '#2c3e50',
      'text-wrap': 'none',
      'padding': '8px',
      'z-index': (ele) => (10 - ele.data('depth')) * 10,
      'transition-property': 'opacity, border-color, border-width',
      'transition-duration': '200ms',
    }
  },
  {
    selector: 'node.root',
    style: {
      'border-color': HIGHLIGHT_COLOR,
      'border-width': 4,
      'z-index': 100,
    }
  },
  {
    selector: 'node:grabbed',
    style: {
      'border-color': HIGHLIGHT_COLOR,
    }
  },
  {
    selector: 'node.highlighted',
    style: {
      'border-color': HIGHLIGHT_COLOR,
      'border-width': 3,
      'z-index': 50,
    }
  },
  // Spotlight: dim everything not connected to the hovered/clicked node
  {
    selector: 'node.dimmed',
    style: {
      'opacity': 0.15,
      'z-index': 0,
    }
  },
  {
    selector: 'node.spotlight',
    style: {
      'opacity': 1,
      'z-index': 60,
      'border-color': HIGHLIGHT_COLOR,
      'border-width': 3,
    }
  },
  {
    selector: 'edge',
    style: {
      'width': 'data(weight)',
      'line-color': '#ccc',
      'curve-style': 'bezier',
      'opacity': 'data(opacity)',
      'z-index': 'data(weight)',
      'transition-property': 'opacity, line-color, width',
      'transition-duration': '200ms',
    }
  },
  {
    selector: 'edge.highlighted',
    style: {
      'line-color': HIGHLIGHT_COLOR,
      'width': (ele) => Math.max(ele.data('weight') + 1, 3),
    }
  },
  {
    selector: 'edge.dimmed',
    style: {
      'opacity': 0.05,
    }
  },
  {
    selector: 'edge.spotlight',
    style: {
      'opacity': 1,
      'line-color': HIGHLIGHT_COLOR,
      'z-index': 50,
    }
  },
];

function init(containerId) {
  cy = cytoscape({
    container: document.getElementById(containerId),
    style,
    elements: [],
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.3,
  });

  // Single tap → show subreddit preview + spotlight
  cy.on('tap', 'node', (e) => {
    const node = e.target;
    spotlightNode(node);
    bus.fire('show-subreddit', node.id());
  });

  // Double tap → expand node
  cy.on('dbltap', 'node', (e) => {
    const node = e.target;
    expandNode(node.id());
  });

  // Hover → spotlight + rich tooltip
  cy.on('mouseover', 'node', (e) => {
    const node = e.target;
    if (!spotlightActive) {
      spotlightNode(node);
    }
    bus.fire('show-tooltip', {
      html: buildTooltipHTML(node),
      x: e.renderedPosition.x,
      y: e.renderedPosition.y,
    });
  });

  cy.on('mouseout', 'node', () => {
    if (!spotlightActive) {
      clearSpotlight();
    }
    bus.fire('hide-tooltip');
  });

  // Tap on background → clear spotlight
  cy.on('tap', (e) => {
    if (e.target === cy) {
      clearSpotlight();
      spotlightActive = false;
    }
  });

  // --- Drag pulls neighbors ---
  cy.on('grab', 'node', (e) => {
    const node = e.target;
    const pos = node.position();
    grabOrigin = { x: pos.x, y: pos.y };

    neighborOrigins = new Map();
    node.neighborhood('node').forEach((neighbor) => {
      if (neighbor.grabbed()) return;
      const npos = neighbor.position();
      neighborOrigins.set(neighbor.id(), { x: npos.x, y: npos.y });
    });
  });

  cy.on('drag', 'node', (e) => {
    if (!grabOrigin || !neighborOrigins) return;

    const node = e.target;
    const pos = node.position();
    const dx = pos.x - grabOrigin.x;
    const dy = pos.y - grabOrigin.y;

    neighborOrigins.forEach((origin, neighborId) => {
      const neighbor = cy.getElementById(neighborId);
      if (neighbor.grabbed()) return;

      const edges = node.edgesWith(neighbor);
      let edgeWeight = 0.5;
      if (edges.length > 0) {
        edgeWeight = edges[0].data('weight') / 6;
      }

      const pull = settings.dragPullStrength * Math.max(0.2, edgeWeight);

      neighbor.position({
        x: origin.x + dx * pull,
        y: origin.y + dy * pull,
      });
    });
  });

  cy.on('free', 'node', (e) => {
    const node = e.target;
    const moved = grabOrigin &&
      (Math.abs(node.position().x - grabOrigin.x) > 20 ||
       Math.abs(node.position().y - grabOrigin.y) > 20);

    grabOrigin = null;
    neighborOrigins = null;

    if (moved) {
      settleNeighbors(node);
    }
  });
}

/**
 * After a node is dropped, fan its direct neighbors evenly around it
 * while keeping all other nodes fixed. Uses fcose with fixedNodeConstraint.
 */
function settleNeighbors(node) {
  const center = node.position();
  const neighbors = node.neighborhood('node');

  if (neighbors.length === 0) return;

  // Build fixed constraints: pin everything EXCEPT the direct neighbors
  const neighborIds = new Set();
  neighbors.forEach((n) => neighborIds.add(n.id()));

  const fixedConstraints = [];
  cy.nodes().forEach((n) => {
    if (!neighborIds.has(n.id())) {
      const pos = n.position();
      fixedConstraints.push({ nodeId: n.id(), position: { x: pos.x, y: pos.y } });
    }
  });

  // Give neighbors a radial hint so fcose starts from a good spot
  const radius = 140;
  const angleStep = (2 * Math.PI) / neighbors.length;
  neighbors.forEach((n, i) => {
    const angle = angleStep * i - Math.PI / 2;
    n.position({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  });

  // Run a quick layout to let fcose settle them properly
  cy.layout({
    name: 'fcose',
    animate: true,
    animationDuration: 400,
    fit: false,
    padding: 50,
    nodeRepulsion: () => 6000,
    idealEdgeLength: () => 120,
    edgeElasticity: () => 0.1,
    numIter: 1000,
    randomize: false,
    quality: 'default',
    fixedNodeConstraint: fixedConstraints,
  }).run();
}

function buildTooltipHTML(node) {
  const nodeId = node.id();

  // Get community size for this node
  const selfDetails = redditDataClient.getDetails(nodeId, nodeId);
  const commenters = selfDetails ? selfDetails.commenters : 0;

  // Always show similarity relative to the current search root
  const rootDetails = currentRoot ? redditDataClient.getDetails(currentRoot, nodeId) : null;

  // Collect connected neighbor names
  const connectedNeighbors = [];
  node.connectedEdges().forEach((edge) => {
    const source = edge.data('source');
    const target = edge.data('target');
    connectedNeighbors.push(source === nodeId ? target : source);
  });

  let html = `<div class="tt-header">r/${nodeId}</div>`;

  // Stats row
  const stats = [];
  if (commenters > 0) {
    stats.push(`<span class="tt-stat"><span class="tt-num">${commenters.toLocaleString()}</span> commenters</span>`);
  }
  if (rootDetails && rootDetails.shared > 0) {
    stats.push(`<span class="tt-stat"><span class="tt-num">${rootDetails.shared.toLocaleString()}</span> cross-posters</span>`);
  }
  if (stats.length) {
    html += `<div class="tt-stats">${stats.join('<span class="tt-dot"></span>')}</div>`;
  }

  // Similarity to current search root
  if (rootDetails && rootDetails.score > 0 && nodeId !== currentRoot) {
    const pct = Math.round(rootDetails.score * 100);
    html += `<div class="tt-similarity">`;
    html += `<div class="tt-bar-track"><div class="tt-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>`;
    html += `<span class="tt-pct">${pct}% similar to r/${currentRoot}</span>`;
    html += `</div>`;
  }

  // Connected to
  if (connectedNeighbors.length > 0) {
    const shown = connectedNeighbors.slice(0, 5).map(n => `<span class="tt-tag">${n}</span>`).join('');
    const more = connectedNeighbors.length > 5 ? `<span class="tt-more">+${connectedNeighbors.length - 5}</span>` : '';
    html += `<div class="tt-connected">${shown}${more}</div>`;
  }

  return html;
}

function spotlightNode(node) {
  // Dim everything
  cy.elements().addClass('dimmed').removeClass('spotlight');

  // Light up this node, its neighbors, and connecting edges
  const neighborhood = node.closedNeighborhood();
  neighborhood.removeClass('dimmed').addClass('spotlight');

  spotlightActive = true;
}

function clearSpotlight() {
  if (!cy) return;
  cy.elements().removeClass('dimmed').removeClass('spotlight');
}

/**
 * Pre-position nodes in concentric rings by depth before running fcose.
 * This gives fcose a radial starting point so the final layout keeps
 * the spoke structure instead of collapsing everything to one side.
 */
function prePositionConcentric(rootId) {
  const rings = new Map(); // depth → [nodeId, ...]
  cy.nodes().forEach((n) => {
    const d = n.data('depth');
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d).push(n);
  });

  // Root at center
  const rootNode = cy.getElementById(rootId);
  if (rootNode.length) {
    rootNode.position({ x: 0, y: 0 });
  }

  // Each depth ring gets progressively larger radius
  const baseRadius = 250;
  rings.forEach((nodes, depth) => {
    if (depth === 0) return; // root already placed

    const radius = baseRadius * depth;
    const angleStep = (2 * Math.PI) / nodes.length;
    // Offset each ring slightly so spokes don't perfectly overlap
    const angleOffset = depth * 0.3;

    nodes.forEach((node, i) => {
      const angle = angleStep * i + angleOffset - Math.PI / 2;
      node.position({
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    });
  });
}

async function renderSearch(query) {
  if (!cy) return;

  cy.elements().remove();
  depthMap.clear();
  spotlightActive = false;
  currentRoot = query;

  // Only fetch depth 1 initially — user expands deeper via double-tap
  const queue = [];
  await fetchAndAddRelated(query, 0, queue);

  // Process queue up to settings.initialDepth only
  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift();
    if (depth >= settings.initialDepth) continue;
    await fetchAndAddRelated(nodeId, depth, queue);
  }

  // Pre-position nodes concentrically before layout:
  // root at center, depth-1 in inner ring, depth-2 in outer ring
  prePositionConcentric(query);

  runLayout();

  // Mark root
  const rootNode = cy.getElementById(query);
  if (rootNode.length) {
    rootNode.addClass('root');
  }
}

async function fetchAndAddRelated(query, currentDepth, queue) {
  try {
    const results = await redditDataClient.getRelated(query);
    if (!results || !results.length) return;

    const parent = results[0];
    const siblingCount = results.length - 1;

    // Add parent node if not present
    if (!cy.getElementById(parent).length) {
      cy.add({
        group: 'nodes',
        data: { id: parent, size: redditDataClient.getSize(parent), depth: currentDepth }
      });
      depthMap.set(parent, currentDepth);
    }

    // Add siblings
    for (let i = 1; i < results.length; i++) {
      const sibling = results[i];
      const siblingDepth = currentDepth + 1;

      // Compute weight from position in sorted array
      const rank = (siblingCount - (i - 1)) / siblingCount;
      const weight = rank * 5 + 1; // 6 (strongest) → 1 (weakest)

      // Skip weak edges entirely
      if (weight < settings.edgeWeightCutoff) continue;

      if (!cy.getElementById(sibling).length) {
        cy.add({
          group: 'nodes',
          data: { id: sibling, size: redditDataClient.getSize(sibling), depth: siblingDepth }
        });
        depthMap.set(sibling, siblingDepth);

        if (queue) {
          queue.push({ nodeId: sibling, depth: siblingDepth });
        }
      }

      // Add edge if not exists
      const edgeId = `${parent}-${sibling}`;
      const reverseEdgeId = `${sibling}-${parent}`;
      if (!cy.getElementById(edgeId).length && !cy.getElementById(reverseEdgeId).length) {
        const opacity = rank * 0.6 + 0.2;

        cy.add({
          group: 'edges',
          data: {
            id: edgeId,
            source: parent,
            target: sibling,
            parentSub: parent,
            weight,
            opacity,
          }
        });
      }
    }
  } catch (err) {
    console.error('Failed to fetch related for', query, err);
  }
}

async function expandNode(nodeId) {
  if (!cy) return;

  // Remember existing node positions for fixed constraints
  const existingPositions = [];
  cy.nodes().forEach((node) => {
    const pos = node.position();
    existingPositions.push({
      nodeId: node.id(),
      position: { x: pos.x, y: pos.y }
    });
  });

  const beforeCount = cy.nodes().length;

  // Fetch and add one level from the clicked node
  await fetchAndAddRelated(nodeId, (depthMap.get(nodeId) || 0), null);

  const afterCount = cy.nodes().length;
  if (afterCount === beforeCount) return;

  // Run layout with fixed constraints for existing nodes
  runLayout(existingPositions);

  // Spotlight the expanded node
  const node = cy.getElementById(nodeId);
  if (node.length) {
    spotlightNode(node);
  }
}

function runLayout(fixedNodeConstraints) {
  if (!cy || cy.nodes().length === 0) return;

  const layoutOptions = {
    name: 'fcose',
    animate: true,
    animationDuration: 600,
    fit: !fixedNodeConstraints,
    padding: 50,
    nodeRepulsion: () => 8000,
    idealEdgeLength: () => 120,
    edgeElasticity: () => 0.1,
    numIter: 2500,
    randomize: false, // always start from current positions (pre-positioned concentrically)
    quality: 'default',
  };

  if (fixedNodeConstraints && fixedNodeConstraints.length > 0) {
    layoutOptions.fixedNodeConstraint = fixedNodeConstraints;
  }

  cy.layout(layoutOptions).run();
}

function destroy() {
  if (cy) {
    cy.destroy();
    cy = null;
  }
  depthMap.clear();
}

function getSettings() {
  return { ...settings };
}

function updateSettings(newSettings) {
  Object.assign(settings, newSettings);
}

export default {
  init,
  renderSearch,
  expandNode,
  destroy,
  getSettings,
  updateSettings,
};
