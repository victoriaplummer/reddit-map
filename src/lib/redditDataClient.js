import createRedditDataClient from "./createRedditDataClient";

const isProd = false;
const dataEndpoint = isProd
  ? "https://sayit-api.YOUR_SUBDOMAIN.workers.dev"
  : "http://localhost:8787";
const redditDataClient = createRedditDataClient(dataEndpoint);

export default redditDataClient;
