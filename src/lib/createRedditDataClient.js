export default function createDataClient(endpoint) {
  // Cache of subreddit sizes populated by getRelated() responses
  const sizes = new Map();
  // Cache of related subreddit arrays
  const relatedCache = new Map();
  // Cache of detail info: { score, shared, commenters } per subreddit pair
  const detailsCache = new Map(); // key: "parent|sub" → { score, shared, commenters }

  return {
    getRelated,
    getSuggestion,
    getSize,
    getDetails,
  }

  function getSize(subName) {
    let size = sizes.get(subName.toLowerCase());
    return size !== undefined ? size : 0.5;
  }

  /**
   * Get detail info for a subreddit as related to a parent.
   * Returns { score, shared, commenters } or null.
   */
  function getDetails(parentSub, subName) {
    return detailsCache.get(parentSub.toLowerCase() + '|' + subName.toLowerCase()) || null;
  }

  function getRelated(query) {
    let key = query.toLowerCase();
    let cached = relatedCache.get(key);
    if (cached) return Promise.resolve(cached);

    return fetch(endpoint + '/api/related?sub=' + encodeURIComponent(query))
      .then(res => res.json())
      .then(data => {
        let related = data.related || [];

        // Cache sizes from the response
        if (data.sizes) {
          Object.keys(data.sizes).forEach(name => {
            sizes.set(name.toLowerCase(), data.sizes[name]);
          });
        }

        // Cache detail info (score, shared commenters, community size)
        if (data.details) {
          const parentKey = key;
          Object.keys(data.details).forEach(name => {
            detailsCache.set(parentKey + '|' + name.toLowerCase(), data.details[name]);
          });
        }

        relatedCache.set(key, related);
        return related;
      });
  }

  function getSuggestion(query) {
    return fetch(endpoint + '/api/suggestions?q=' + encodeURIComponent(query))
      .then(res => res.json())
      .then(suggestions => {
        return suggestions.map(s => ({
          html: s.html,
          text: s.text
        }));
      });
  }
}
