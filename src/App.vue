<template>
  <div id="app">
    <form v-on:submit.prevent="onSubmit" class="search-box">
      <typeahead
        placeholder="Enter subreddit name"
        ref:typeahead
        @selected="doSearch"
        :query="appState.query"
        :get-suggestions="getSuggestions"
      ></typeahead>
    </form>

    <div class="settings-toggle" @click="settingsOpen = !settingsOpen">
      <span class="settings-icon">&#9881;</span>
      <span>{{ settingsOpen ? 'Hide settings' : 'Settings' }}</span>
    </div>

    <div class="settings-pane" v-if="settingsOpen">
      <label class="setting-row">
        <span class="setting-label">Depth</span>
        <input type="range" min="1" max="3" step="1"
          :value="graphSettings.initialDepth"
          @input="onSettingChange('initialDepth', Number($event.target.value))">
        <span class="setting-value">{{ graphSettings.initialDepth }}</span>
      </label>
      <label class="setting-row">
        <span class="setting-label">Edge cutoff</span>
        <input type="range" min="1" max="5" step="0.5"
          :value="graphSettings.edgeWeightCutoff"
          @input="onSettingChange('edgeWeightCutoff', Number($event.target.value))">
        <span class="setting-value">{{ graphSettings.edgeWeightCutoff }}</span>
      </label>
      <label class="setting-row">
        <span class="setting-label">Drag pull</span>
        <input type="range" min="0" max="1" step="0.05"
          :value="graphSettings.dragPullStrength"
          @input="onSettingChange('dragPullStrength', Number($event.target.value))">
        <span class="setting-value">{{ graphSettings.dragPullStrength.toFixed(2) }}</span>
      </label>
      <button class="settings-apply" @click="rerender">Apply &amp; re-render</button>
    </div>

    <div class="help" v-if="!appState.hasGraph">
      The graph of related subreddits
      <a
        href="#"
        @click.prevent="aboutVisible = true"
        class="highlight"
      >Learn more.</a>
    </div>
    <div class="help" v-if="loading">Loading...</div>
    <div class="about-line">
      <a class="about-link" href="#" @click.prevent="aboutVisible = true">about</a>
      <a class="bold" href="https://github.com/anvaka/sayit">source code</a>
    </div>

    <about v-if="aboutVisible" @close="aboutVisible = false"></about>

    <div class="welcome" v-if="!appState.hasGraph">
      <h3>Welcome!</h3>
      <p>
        This website renders graph of related subreddits.
        <a
          class="highlight"
          href="#"
          @click.prevent="aboutVisible = true"
        >Click here</a> to learn more, or
        <a class="highlight" href="?query=math">try demo</a>.
      </p>
    </div>

    <div class="tooltip" ref="tooltip" :class="{ visible: tooltip.visible }" v-html="tooltip.html"></div>
    <subreddit v-if="subreddit" :name="subreddit" class="preview"></subreddit>
    <div class="close-container" v-if="subreddit">
      <a href="#" @click.prevent="subreddit = null">close</a>
    </div>
  </div>
</template>

<script>
import "vuereddit/dist/vuereddit.css";

import appState, { setQuery } from "./appState.js";
import Subreddit from "vuereddit";
import cytoscapeGraph from "./lib/cytoscapeGraph";
import About from "./components/About";
import Typeahead from "./components/Typeahead";
import bus from "./bus";
import redditDataClient from "./lib/redditDataClient";

export default {
  name: "App",
  data() {
    return {
      aboutVisible: false,
      subreddit: null,
      loading: false,
      settingsOpen: false,
      appState,
      graphSettings: cytoscapeGraph.getSettings(),
      tooltip: {
        html: "",
        visible: false,
      }
    };
  },
  components: {
    About,
    Typeahead,
    Subreddit
  },
  methods: {
    doSearch(q) {
      // q may be a string (from Typeahead) or CustomEvent (from bus)
      const query = (q && q.detail) ? q.detail : q;
      appState.query = query;
      this.onSubmit();
    },
    getSuggestions(input) {
      return redditDataClient.getSuggestion(input);
    },
    async onSubmit() {
      if (!appState.query) return;

      setQuery(appState.query);
      this.loading = true;
      await cytoscapeGraph.renderSearch(appState.query);
      this.loading = false;

      const el = document.querySelector(":focus");
      if (el) el.blur();
    },
    showSubreddit(e) {
      this.subreddit = e.detail;
    },
    showTooltip(e) {
      const data = e.detail;
      const tooltipEl = this.$refs.tooltip;
      if (tooltipEl) {
        tooltipEl.style.left = (data.x + 15) + 'px';
        tooltipEl.style.top = (data.y - 10) + 'px';
      }
      this.tooltip.html = data.html || data.text || '';
      this.tooltip.visible = true;
    },
    hideTooltip() {
      this.tooltip.visible = false;
    },
    onSettingChange(key, value) {
      this.graphSettings[key] = value;
      cytoscapeGraph.updateSettings({ [key]: value });
    },
    async rerender() {
      if (!appState.query) return;
      this.loading = true;
      await cytoscapeGraph.renderSearch(appState.query);
      this.loading = false;
    },
  },
  mounted() {
    cytoscapeGraph.init('cy');

    bus.on('show-subreddit', this.showSubreddit);
    bus.on('new-search', this.doSearch);
    bus.on('show-tooltip', this.showTooltip);
    bus.on('hide-tooltip', this.hideTooltip);

    if (appState.query) {
      this.onSubmit();
    }
  },

  beforeDestroy() {
    bus.off('show-subreddit', this.showSubreddit);
    bus.off('new-search', this.doSearch);
    bus.off('show-tooltip', this.showTooltip);
    bus.off('hide-tooltip', this.hideTooltip);
    cytoscapeGraph.destroy();
  }
};
</script>

<style lang='stylus'>
@import ('./vars.styl');

#app {
  position: relative;
  margin: 8px 14px;
  width: 392px;
  background: background-color;
}

.close-container {
  position: fixed;
  z-index: 2;
  top: 0;
  right: 0;
  height: 40px;

  a {
    padding: 0 12px;
    font-size: 12px;
    color: #fff;
    background-color: #333;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
}

.highlight {
  color: highlight-color;
}

.settings-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: secondary-color;
  cursor: pointer;
  padding: 4px 0;
  user-select: none;

  &:hover {
    color: highlight-color;
  }
}

.settings-icon {
  font-size: 14px;
}

.settings-pane {
  background: background-color;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 8px 12px;
  margin-bottom: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #555;
  margin: 4px 0;
  cursor: default;
}

.setting-label {
  width: 72px;
  flex-shrink: 0;
}

.setting-row input[type="range"] {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #ddd;
  border-radius: 2px;
  outline: none;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: highlight-color;
    cursor: pointer;
  }
}

.setting-value {
  width: 32px;
  text-align: right;
  font-family: monospace;
  font-size: 11px;
  flex-shrink: 0;
}

.settings-apply {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px 0;
  font-size: 12px;
  background: highlight-color;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;

  &:hover {
    opacity: 0.9;
  }
}

.help {
  font-size: 12px;
  margin-top: 8px;

  a {
    background: background-color;
  }
}

.special {
  color: highlight-color;
  font-family: monospace;
}

a {
  text-decoration: none;
}

.about-line {
  position: fixed;
  right: 0;
  top: 8px;
  padding: 0px 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;

  a {
    text-align: right;
    background: background-color;
    font-size: 12px;
    padding: 0 8px;
    line-height: 24px;
    height: 24px;
    color: secondary-color;
    border-bottom: 1px solid transparent;

    &:hover, &:focus {
      color: highlight-color;
      border-bottom: 1px dashed;
    }
  }
}

.tooltip {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
  position: fixed;
  background: background-color;
  padding: 10px 12px;
  border: none;
  border-radius: 6px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
  z-index: 10;
  max-width: 280px;
  font-size: 12px;
  line-height: 1.4;
  color: #555;
}

.tooltip.visible {
  opacity: 1;
}

.tt-header {
  font-size: 14px;
  font-weight: 600;
  color: primary-text;
  margin-bottom: 6px;
}

.tt-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tt-stat {
  white-space: nowrap;
}

.tt-num {
  font-weight: 600;
  color: primary-text;
}

.tt-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #ccc;
  display: inline-block;
  flex-shrink: 0;
}

.tt-similarity {
  margin-bottom: 8px;
}

.tt-bar-track {
  height: 4px;
  background: #eee;
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 3px;
}

.tt-bar-fill {
  height: 100%;
  background: highlight-color;
  border-radius: 2px;
  transition: width 200ms ease;
}

.tt-pct {
  font-size: 11px;
  color: #888;
}

.tt-connected {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #eee;
}

.tt-tag {
  background: #f3f3f3;
  color: #555;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  white-space: nowrap;
}

.tt-more {
  color: #aaa;
  font-size: 10px;
  padding: 1px 4px;
}

.search-box {
  position: relative;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 -1px 0px rgba(0, 0, 0, 0.02);
  height: 48px;
  display: flex;
  font-size: 16px;
  padding: 0;
  cursor: text;

  span {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
}

.subreddit.preview {
  position: fixed;
  right: 0;
  top: 0;
  width: 400px;
  overflow: hidden;

  a {
    target: '_blank';
  }

  .controls {
    position: absolute;
    top: 42px;
    right: 0;
    left: 1px;
    height: 32px;
  }
}

.title-area {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 42px;
}

@media (max-width: 800px) {
  #app {
    width: 100%;
    margin: 0;
  }

  .welcome {
    padding: 16px;
  }

  .help {
    padding: 0 8px;
  }

  .about-line {
    bottom: 0;
    top: initial;
    right: 0;
  }

  .subreddit.preview {
    width: 100%;
  }
}

.details-container {
  position: absolute;
  top: 82px;
  bottom: 0;
  left: 0;
  right: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

@media (max-height: 550px) {
  .search-box {
    height: 32px;

    input.search-input {
      font-size: 16px;
    }
  }

  .help {
    margin-top: 4px;
  }
}
</style>
