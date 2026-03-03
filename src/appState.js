import queryState from 'query-state';

const qs = queryState(
  {
    query: ''
  },
  {
    useSearch: true
  }
);

const appStateFromQuery = qs.get();
const appState = {
  hasGraph: false,
  query: appStateFromQuery.query
};

export default appState;

qs.onChange(function updateAppState(newState) {
  appState.query = newState.query;
});

export function setQuery(queryString) {
  appState.hasGraph = true;
  qs.set('query', queryString);
}
