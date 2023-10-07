const path = require("path");
const _ = require("lodash");


const pathSep = path.sep;

const defaultPath = [
  "locales",
];

class TestPlugin {
  constructor(options, path = defaultPath) {
    this.warnings = this.errors = 0;
    this.options = this.sanitizeOptions(options);
    this.preprocessOptions();
    /* This RegExp has to:
        * identify localization resource
        * parse locale and namespace name
        Example of a localization resource: "<some path>/locales/en-us/namespace1"
    */
    this.localizationResourcePathSubstring =
      path.join(
        pathSep
      );
  }

  /**
   * @param {Compiler} compiler
   */
  apply(compiler) {
    compiler.hooks.thisCompilation.tap(this.id, compilation => {
      compilation.hooks.optimizeModules.tap(this.id, () => {
        const mergeFunction = this.mergeChunksV5;

        this.consolidateChunks(compilation, mergeFunction);
      });
    });
  }

  /**
   * Consolidate chunks based on the plugin configuration -> let the plugin do its jobs
   * @param {Compilation} compilation The compilation object
   * @param {Compilation} mergeFunction Versioned function to do the consolidation
   */
  consolidateChunks(compilation, mergeFunction) {
    mergeFunction.bind(this)(compilation);
  }

  /**
   * Integrate chunks with entry chunks according to the entry chunks configuration
   *
   * @param {Compilation} compilation The compilation object
   */
  integrateWithEntryChunks(compilation) {
    const chunks = compilation.chunks || [];
    const entryChunksMap = this.getEntryChunksMap(compilation, chunks);

    this.validateEntryChunksMap(entryChunksMap);
    const entriesCount = Object.entries(this.options.entry).length;
    for (const chunk of chunks) {
      if (entryChunksMap.has(chunk)) {
        continue;
      }

      let loopCount = 0;

      for (const [entryName, entry] of Object.entries(this.options.entry)) {
        loopCount++;
        if (
          this.canIntegrateChunkWithEntry(compilation, entry, chunk) &&
          entryChunksMap.has(entryName)
        ) {
          const entryChunk = entryChunksMap.get(entryName);


          // the chunk is common for all entries and it should be removed when we finished parsing the entries
          if (loopCount === entriesCount) {
            this.moveChunkModules(compilation, chunk, entryChunk);
            this.removeEmptyChunk(compilation, chunk);
          } else {
            for (const module of this.getModules(compilation, chunk)) {
              if (!entryChunk.containsModule(module)) {
                entryChunk.addModule(module);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Validates that the configuration receivedfor entry  is valid
   **/
  validateEntryChunksMap(entryChunksMap) {
    for (const entryName in this.options.entry) {
      if (!entryChunksMap.has(entryName)) {
        this.throw(
          `There is configured "${entryName}" entry chunk, but it has NOT been found in code`
        );
      }
    }
  }

  /**
   * Merge chunks according to the non-entry chunks configuration and remove all other non-entry chunks.
   * @param {Compilation} compilation The compilation object
   */
  mergeChunksV5(compilation) {
    const chunks = compilation.chunks || new Set();

    const newChunkMap = new Map(); // map new chunk name -> chunk

    for (const chunk of chunks) {
      if (this.isEntryChunk(compilation, chunk)) {
        // entry chunks are not going to be merged to a non-entry chunk
        continue;
      }
      if (newChunkMap.has(chunk.name)) {
        // it's chunk created by this method
        continue;
      }
      let isChunkMerged = false;
      for (const configChunk of this.options.chunks) {
        const locale = this.getLocaleToMergeChunkToConfigChunk(
          compilation,
          chunk,
          configChunk
        );
        if (locale) {
          // the chunk has to be merged to the configChunk under the locale
          const newChunkName = `${configChunk.name}-${locale}`;
          if (!newChunkMap.has(newChunkName)) {
            // when the target chunk doesn't exist yet, create it
            const newChunkGroup = compilation.addChunk(newChunkName);
            newChunkMap.set(newChunkName, newChunkGroup);
          }
          const newChunk = newChunkMap.get(newChunkName);
          compilation.chunkGraph.integrateChunks(newChunk, chunk);
          newChunk.name = newChunkName;

          isChunkMerged = true;
          break;
        }
      }
      // localization chunks that has to be merged to to no entry chunk and no non-entry chunk has to be removed
      // if the chunk would be merged to an entry chunk, it would not appear there as the merge to entry chunks is run before the merge to non-entry chunks - see integrateWithEntryChunks method
      if (!isChunkMerged && this.isLocalizationChunk(compilation, chunk)) {
        this.removeEmptyChunk(compilation, chunk);
      }
    }
  }

  /**
   * Check if the chunk has to be integrated to the entry
   *
   * @param {Compilation} compilation The compilation object
   * @param {object} entry The entry configuration object
   * @param {Chunk} chunk The checked chunk
   * @returns {boolean} true, if the chunk has to be integrated to the entry, otherwise false
   */
  canIntegrateChunkWithEntry(compilation, entry, chunk) {
    const modules = this.getModules(compilation, chunk);
    for (const m of modules) {
      const resource = m.resource;
      const parsedResource = this.parseResource(resource);
      if (!parsedResource) {
        // undefined -> the resource is not localization resource
        continue;
      }
      const { locale, namespace } = parsedResource;
      if (entry.bundledNamespaces.indexOf(namespace) > -1) {
        const isEntryIncludesLocale =
          entry.includeAllLocales || entry.bundledLocales.indexOf(locale) > -1;
        if (isEntryIncludesLocale) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if the chunk should be merged to the configured chunk and return chunk's locale when it has to be merged.
   *
   * @param {Compilation} compilation The compilation object
   * @param {Chunk} chunk The chunk to test
   * @param {object} configChunk The configuration chunk to test
   * @returns {string} the locale string, if the chunk to be merged to the configured chunk, otherwise undefined
   */
  getLocaleToMergeChunkToConfigChunk(compilation, chunk, configChunk) {
    if (configChunk.excludeAllLocales) {
      return undefined;
    }
    const modules = this.getModules(compilation, chunk);
    for (const module of modules) {
      const resource = module.resource;
      const parsedResource = this.parseResource(resource);
      if (!parsedResource) {
        continue;
      }
      const { locale, namespace } = parsedResource;
      if (configChunk.excludeLocales.indexOf(locale) > -1) {
        continue;
      }
      if (configChunk.namespaces.indexOf(namespace) > -1) {
        return locale;
      }
    }
    return undefined;
  }

  /**
   * Parse the localization resource
   *
   * @param {string} resource The resource string
   * @returns {object} The parsed localization resource object, or undefined when the resource is not a localization resource
   */
  parseResource(resource) {
    if (!resource || !this.isLocalizationResource(resource)) {
      return undefined;
    }
    // Extract locale and namespace from the localizationResource.
    // return {locale = "en-us", namespace = "namespace2"}
    const resourceSplit = resource.split(pathSep);
    const match = [
      resourceSplit[resourceSplit.length - 1],
      resourceSplit[resourceSplit.length - 2],
    ];
    if (match[0].length > 3 && match[1].length > 0) {
      return {
        locale: match[1],
        namespace: match[0].slice(0, match[0].length - 3),
      };
    }
    return undefined;
  }

  /**
   * Filter out entry chunks and return them in map, where:
   * key is the entry chunk name
   * value is the entry chunk
   * @param {Chunk[]} chunks
   * @returns {Map} The entry chunk map
   */
  getEntryChunksMap(compilation, chunks) {
    const entryChunksMap = new Map();
    for (const chunk of chunks) {
      if (this.isEntryChunk(compilation, chunk)) {
        entryChunksMap.set(chunk.name, chunk);
      }
    }
    return entryChunksMap;
  }

  /**
   * Is the chunk an entry chunk?
   * @param {Compilation} compilation The compilation object
   * @param {Chunk} chunk The chunk to check
   * @returns {boolean} true, if the chunk is an entry chunk, otherwise false
   */
  isEntryChunk(compilation, chunk) {
    return compilation.chunkGraph
      ? compilation.chunkGraph.getNumberOfEntryModules(chunk) > 0
      : chunk.hasEntryModule();
  }

  /**
   * Is the chunk localization chunk?
   * @param {Compilation} compilation The compilation object
   * @param {Chunk} chunk The chunk to check
   * @returns {boolean} true, if the chunk is localization chunk, otherwise false
   */
  isLocalizationChunk(compilation, chunk) {
    const modules = this.getModules(compilation, chunk);
    for (const m of modules) {
      const resource = m.resource;
      if (this.isLocalizationResource(resource)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Is the resource a localization resource?
   * @param {string} resource The resource
   * @returns {boolean} true, if the resource is a localization resource, otherwise false
   */
  isLocalizationResource(resource) {
    return (
      !!resource &&
      resource.includes(this.localizationResourcePathSubstring) &&
      resource.endsWith(".js")
    );
  }

  /**
   * Configuration pre-processing to simplify chunks integration
   */
  preprocessOptions() {
    for (const entryName in this.options.entry) {
      const entry = this.options.entry[entryName];
      // transform namespace to namespace file name
      entry.bundledNamespaces = entry.bundledNamespaces.map(namespace =>
        _.kebabCase(namespace)
      );
      // normalize locale
      entry.bundledLocales = entry.bundledLocales.map(locale =>
        locale.toLowerCase()
      );
      // set entry.includeAllLocales
      entry.includeAllLocales = entry.bundledLocales.indexOf("*") > -1;
    }
    for (const chunk of this.options.chunks) {
      // transform namespace to namespace file name
      chunk.namespaces = chunk.namespaces.map(namespace =>
        _.kebabCase(namespace)
      );
      // filter out locales bundled to entry chunks
      chunk.excludeLocales = null;
      chunk.excludeAllLocales = false;
      for (const namespace of chunk.namespaces) {
        const nsCommon = this.getIntersectionNsEntryLocales(namespace);
        chunk.excludeLocales = chunk.excludeLocales
          ? this.getIntersetionLocales(chunk.excludeLocales, nsCommon)
          : nsCommon;
      }
      if (_.isEqual(chunk.excludeLocales, ["*"])) {
        chunk.excludeLocales = [];
        chunk.excludeAllLocales = true;
      }
    }
  }

  /**
   * Check all configured entry chunks for the namespace and return intersection locales
   * @param {string} namespace
   * @returns {string[]|["*"]} intersection locales
   */
  getIntersectionNsEntryLocales(namespace) {
    let locales = [];

    for (const entryName in this.options.entry) {
      const entry = this.options.entry[entryName];
      if (entry.bundledNamespaces.indexOf(namespace) > -1) {
        locales = locales.length
          ? this.getIntersetionLocales(locales, entry.bundledLocales)
          : entry.bundledLocales;
      } else {
        return [];
      }
    }
    return locales;
  }

  /**
   * Get intersection locales for arr1 and arr2.
   * Please note, the value ["*"] meaning is "all locales", so it should return the other array when one of arrays has this value.
   *
   * @param {string[]} arr1 The locales array 1
   * @param {string[]} arr2 The locales array 2
   */
  getIntersetionLocales(arr1, arr2) {
    if (_.isEqual(arr1, ["*"])) {
      return arr2;
    }
    if (_.isEqual(arr2, ["*"])) {
      return arr1;
    }
    return _.intersection(arr1, arr2);
  }

  /**
   * Sanitize the configuration object
   *
   * @param {object} options The configuration object to sanitize
   * @returns {object} The sanitized configuration object
   * @throws {Error} On a configuration problem
   */
  // eslint-disable-next-line msteams/function-complexity
  sanitizeOptions(options) {

    // chunks
    options.chunks = options.chunks || [];
    if (!_.isArray(options.chunks)) {
      this.throw(
        "The chunks is configured with unsupported value. It must be array of objects, but it's configured to",
        options.chunks
      );
    }
    for (const chunk of options.chunks) {
      if (!_.isPlainObject(chunk)) {
        this.throw(
          "One of chunks is configured with unsupported value. It must be object, but it's configured to",
          chunk
        );
      }

      // chunk.name
      if (!_.isString(chunk.name)) {
        this.throw(
          "Chunk name is configured with unsupported value. It must be string, but it's configured to",
          chunk.name
        );
      }
      if (!chunk.name.length) {
        this.throw(
          "Chunk name can't be empty string. Please review configuration of",
          chunk
        );
      }
      const localeIdentifier = "-locale";
      if (!chunk.name.endsWith(localeIdentifier)) {
        chunk.name = chunk.name + localeIdentifier;
      }

      // chunk.namespaces
      if (!_.isArray(chunk.namespaces)) {
        this.throw(
          "Chunk namespaces is configured with unsupported value. It must be array of namespace strings, but it's configured to",
          chunk.namespaces
        );
      }
      if (!chunk.namespaces.length) {
        this.throw(
          "Every chunk configuration has to have configured a namespace. Please review chunks configuration",
          chunk
        );
      }
      for (const ns of chunk.namespaces) {
        if (!_.isString(ns)) {
          this.throw(
            "Chunk namespaces is configured with unsupported value. It must be array of namespace strings, but it's configured to",
            chunk.namespaces
          );
        }
        if (!ns.length) {
          this.throw(
            "Chunk namespaces can't contain empty string. Please review configuration of",
            chunk
          );
        }
      }
    }

    if (_.isEqual(options.entry, {}) && _.isEqual(options.chunks, [])) {
      this.throw(
        `The ${this.id} must receive a non-empty configuration. The empty configuration would force webpack to remove all locales - and you do NOT want it for sure`
      );
    }

    this.checkNamespaces(options);
    return options;
  }

  /**
   * Do namespaces checks
   * @param {object} options The configuration object
   * @throws {Error} When a problem is found
   */
  checkNamespaces(options) {
    this.checkNoNsInMoreChunks(options);
    this.checkEntryNssLocaleCoverage(options);
  }

  /**
   * Configuration check: Check there is no namespace used by more than one non-entry chunk
   * @param {object} options The configuration object
   * @throws {Error} When a namespace used by two or more non-entry chunks
   */
  checkNoNsInMoreChunks(options) {
    const namespaces = new Map();
    for (const chunk of options.chunks) {
      for (const namespace of chunk.namespaces) {
        if (namespaces.has(namespace)) {
          this.throw(
            `The namespace "${namespace}" is used by "${
              chunk.name
            }" and also by "${
              namespaces.get(namespace).name
            }" non-entry chunk. Any namespace can be used by one non-entry chunk max.`
          );
        }
        namespaces.set(namespace, chunk);
      }
    }
  }

  /**
   * Check entry chunk namespaces locale coverage.
   * All entry chunk namespaces have to have full locale coverage - so, when the entry chunk doesn't contain all locales,
   * its namespaces must be part of other non-entry chunk/chunks too.
   * @param {object} options The configuration object
   * @throws {Error} When an entry chunk namespace has not full locale coverage
   */
  checkEntryNssLocaleCoverage(options) {
    for (const entryName in options.entry) {
      const entry = options.entry[entryName];
      if (
        entry.bundledLocales === "*" ||
        _.isEqual(entry.bundledLocales, ["*"])
      ) {
        continue;
      }
      for (const namespace of entry.bundledNamespaces) {
        const nsChunk = this.getNonEntryChunkForNs(namespace, options);
        if (!nsChunk) {
          this.throw(
            `The "${namespace}" namespace is part of "${entryName}" entry chunk, but it has not full locale coverage. When an entry chunk contains just certain locales, all namespaces must be part of a non-entry chunk too.`
          );
        }
      }
    }
  }

  /**
   * Get the configuration non-entry chunk for the namespace
   * @param {string} namespace
   * @param {object} options The configuration object, optional parameter
   * @returns {object} configuration non-entry chunk, if the namespace is used by a non-entry chunk, otherwise null
   */
  getNonEntryChunkForNs(namespace, options) {
    options = options || this.options;
    for (const chunk of options.chunks) {
      if (chunk.namespaces.indexOf(namespace) > -1) {
        return chunk;
      }
    }
    return null;
  }

  /**
   * Get all modules in a chunk
   * @param {Compilation} compilation The compilation object
   * @returns {Chunk} The chunk to get modules from
   * @returns {Module[]} The list of chunks
   */
  getModules(compilation, chunk) {
    return compilation.chunkGraph
      ? compilation.chunkGraph.getOrderedChunkModulesIterable(chunk)
      : chunk.getModules();
  }

  /**
   * Move all modules from oldChunk to newChunk
   * @param {Compilation} compilation The compilation object
   * @param {Chunk} oldChunk
   * @param {Chunk} newChunk
   */
  moveChunkModules(compilation, oldChunk, newChunk) {
    for (const module of this.getModules(compilation, oldChunk)) {
      oldChunk.moveModule(module, newChunk);
    }
    oldChunk._modules && oldChunk._modules.clear();
  }

  /**
   * Remove the empty chunk properly
   * @param {Compilation} compilation
   * @param {Chunk} chunk
   */
  removeEmptyChunk(compilation, chunk) {
    if (compilation.chunkGraph) {
      return compilation.chunkGraph.disconnectChunk(chunk);
    }

    for (const module of this.getModules(compilation, chunk)) {
      chunk.removeModule(module);
      const index = compilation.modules.indexOf(module);
      if (index >= 0) {
        Array.from(compilation.modules).splice(index, 1);
      }
    }
    const index = compilation.chunks.indexOf(chunk);
    if (index >= 0) {
      Array.from(compilation.chunks).splice(index, 1);
    }
    chunk.remove();
  }

  /**
   * Log the args to the error log and throw.
   * This is the preferred way how to stop webpack building with an error message.
   *
   * @param  {any[]} args Any args for error log
   * @throws {Error}
   */
  throw(args) {
    const helpMessage =
      "Please check your webpack config and the configuration passed to the TestPlugin and run the build again";

    this.errors++;
    throw new Error(helpMessage);
  }

  /**
   * The plugin's ID
   */
  get id() {
    return "TestPlugin";
  }
}

module.exports = { TestPlugin };
