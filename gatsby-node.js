// I heavily used currying here to keep things DRY.

const crypto = require('crypto');
const stringify = require('json-stringify-safe');
const StoryblokClient = require('storyblok-js-client');

/**
 * Create a function that creates a function that fetches paginated storyblok data from the CDN.
 *
 * @param {*} client the storyblok client
 * @param {*} version the storyblok version to fetch (`draft`, for example)
 * @param {*} setPluginStatus callback function from gatsby to query the plugin status
 */
const createFetcherBase = (client, version, setPluginStatus) => type => { // curry all the things
  return () => new Promise((res, rej) => {
    let count = 0;
    const results = [];

    const getItems = (page = 1) => {
      return client.get(type, {
        version,
        per_page: 10,
        page,
      })
        .then(res => {
          setPluginStatus({ lastFetched: Date.now() });

          const keys = Object.keys(res.data);

          if (keys.length !== 1) {
            throw new Error("Got multiple keys in res.data from the API.");
          }

          // If we fetch /stories, we get 'stories' here, if we fetch data sources, we
          // get `datasource_entries`, etc.. Point is, res.data contains just a single
          // key and we want to know it.
          const keyOfItemFetched = keys[0];

          results.push(...res.data[keyOfItemFetched]);
          count += res.data[keyOfItemFetched].length;

          // If we have items left to fetch and its not the last page (in the original sources
          // both checks were present even though they should be technically equivalent) fetch
          // the next page.
          if (count !== res.total && page <= Math.ceil(res.total / res.perPage)) {
            return getItems(page + 1);
          }
        });
    };

    getItems()
      .then(() => res(results))
      .catch(rej);
  });
};

/**
 * Creates a function that processes items received from storybloks API to be
 * for gatsby.
 *
 * @param {*} createNode the gatsby callback to create a GraphQL node
 * @param {*} name the name of the node
 * @param {*} predicate optional, a processor function that will be applied to every node before it is handed to gatsby
 */
const createItemsProcessor = (createNode, name, predicate) => items => {
  for (const item of items) {
    const node = Object.assign({}, item, {
      id: `${name.toLowerCase()}-${item.id}`,
      parent: null,
      children: [],
      internal: {
        mediaType: `application/json`,
        type: name,
        contentDigest: crypto.createHash(`md5`).update(stringify(item)).digest(`hex`)
      }
    });

    if (predicate) {
      predicate(node);
    }
    createNode(node);
  }
};

exports.sourceNodes = ({ boundActionCreators }, options) => {
  const { createNode, setPluginStatus } = boundActionCreators;
  const client = new StoryblokClient(options);

  // First create the functions that abstract the API pagination and pre-processing
  const createPaginatedFetcher = createFetcherBase(
    client,
    options.version,
    setPluginStatus,
  );

  const fetchStories = createPaginatedFetcher('cdn/stories');
  const fetchTags = createPaginatedFetcher('cdn/tags');

  const processStories = createItemsProcessor(
    createNode,
    'StoryblokEntry',
    item => item.content = stringify(item.content),
  );
  const processTags = createItemsProcessor(createNode, 'StoryblokTag');

  // Load data sources specified in the config. Specifying them in the config is
  // required for now, but hopefully can be made simpler in the future.
  const fetchingDataSources = (options.dataSources || []).map(s => {
    const fetchEntries = createPaginatedFetcher(`cdn/datasource_entries?datasource=${s}`);
    const processEntries = createItemsProcessor(
      createNode,
      'StoryblokDataSourceEntry',
      item => item.data_source = s,
    );

    return fetchEntries().then(processEntries);
  });

  const fetchingStories = fetchStories().then(processStories);
  const fetchingTags = fetchTags().then(processTags);

  // And wait until everything has been inserted into GraphQL
  return Promise.all([fetchingStories, fetchingTags].concat(fetchingDataSources));
};
