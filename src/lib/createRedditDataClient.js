export default function createDataClient(endpoint) {
  // Cache of subreddit sizes populated by getRelated() responses
  const sizes = new Map();
  // Cache of related subreddit arrays
  const relatedCache = new Map();

  return {
    getRelated,
    getSuggestion,
    getSize
  }

  function getSize(subName) {
    let size = sizes.get(subName.toLowerCase());
    return size !== undefined ? size : 0.5;
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
