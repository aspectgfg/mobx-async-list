import _ from "lodash";
import {
  action,
  computed,
  IObservableArray,
  observable,
  runInAction,
} from "mobx";
import { SearchObservable } from "./search_observable";
export type ItemType = { id: number | string };
export type PagingVars = {
  offset: number;
  limit: number;
  up_to?: Date;
};

const HAS_MORE_THRESHOLD = 2;
export const CHUNK_2_1 = [2, 1];

export type SearchSpec<Local, Remote> = {
  local: (term: string) => Local[];
  remote: (term: string) => Promise<Remote[]>;
};

export interface ListInit<T extends ItemType, V extends {}> {
  name: string;
  doFetch: (vars: V & PagingVars) => Promise<T[]>;
  variables: Omit<V, keyof PagingVars>;
  noPaging?: boolean;
  pageSize?: number;
  chunking?: number[];
  sort?: (items: T[]) => T[];
  onFetch?: (items: T[]) => void;
  beforeRefresh?: () => Promise<any>;
  load?: boolean;
  shallow?: boolean;
  clearOnRefresh?: boolean;
  initialItems?: T[];
  afterRefresh?: () => void;
  search?: SearchSpec<any, any>;
  log?: boolean;
}

const DefaultPaging = { limit: "limit", offset: "offset", isPages: false };
export class List<T extends ItemType, V extends {}> {
  items: IObservableArray<T>;
  @computed get ids() {
    return new Set(_.map(this.items, "id"));
  }
  @observable loading = false;
  @observable refreshing = false;
  @observable hasMore = true;
  noPaging = false;
  variables: Omit<V, keyof PagingVars>;
  pageSize: number = 20;
  pagingStarted = new Date().toISOString();
  name: string;
  chunking?: number[];
  beforeRefresh?: () => Promise<any>;
  sort?: (items: T[]) => T[];
  @computed get chunked() {
    return this._chunked;
  }
  @observable _chunked: T[][] = [];
  onFetch?: (items: T[]) => void;
  doFetch: (vars: V & PagingVars) => Promise<T[]>;
  clearOnRefresh?: boolean;
  afterRefresh?: () => void;
  log?: boolean;
  doSearch?: SearchSpec<T, any>;

  constructor(props: ListInit<T, V>) {
    this.items = observable.array([]);
    this.name = props.name;
    this.doFetch = props.doFetch;
    this.variables = props.variables;
    this.noPaging = props.noPaging || false;
    if (this.noPaging) runInAction(() => (this.hasMore = false));
    if (props.pageSize) this.pageSize = props.pageSize;
    this.chunking = props.chunking;
    this.sort = props.sort;
    this.onFetch = props.onFetch;
    this.beforeRefresh = props.beforeRefresh;
    // @ts-ignore
    this.paging = props.paging || DefaultPaging;
    this.clearOnRefresh = props.clearOnRefresh;
    this.afterRefresh = props.afterRefresh;
    if (props.initialItems) {
      this.setItems(props.initialItems);
    }
    this.log = props.log;
    this.doSearch = props.search;
    if (props.load) this.load();
  }

  @action addItems(items: T[], prepend = false) {
    items = items.filter((it) => !this.ids.has(it.id));
    if (!items.length) return;
    if (prepend) {
      this.items.unshift(...items);
    } else {
      this.items.push(...items);
    }
  }

  @action addItem(item: T, prepend = false) {
    let index = _.findIndex(this.items, (it) => it.id == item.id);
    if (index == -1) {
      if (this.sort) this.items.replace(this.sort([...this.items, item]));
      else prepend ? this.items.unshift(item) : this.items.push(item);
    }
  }

  getItem(id: T["id"]): T | undefined {
    return _.find(this.items, (it) => it.id == id);
  }

  @action getItemIndex(id: T["id"]): number {
    return _.findIndex(this.items, (it) => it.id == id);
  }

  @action removeItems(items: T["id"][]) {
    for (let id of items) {
      let it = this.getItem(id);
      if (it) {
        this.items.remove(it);
      }
    }
  }

  @action removeItem(item: T | T["id"]) {
    let id = _.isObject(item) ? item.id : item;
    let index = this.items.findIndex((it) => it.id == id);
    if (index > -1) {
      this.items.splice(index, 1);
    }
  }

  @action setItems(items: T[], wasLoaded = true) {
    if (this.sort) items = this.sort(items);
    this.items.replace(items);
    if (wasLoaded && !items.length) this.hasMore = false;
  }

  @action moveItem(item: T, toIndex: number, add = false) {
    let _item = this.getItem(item.id);
    if (_item) this.items.remove(_item);
    if (_item || add) {
      this.items.splice(toIndex, 0, item);
      let items = [
        ...this.items.slice(0, toIndex),
        item,
        ...this.items.slice(toIndex),
      ];
      this.items.replace(items);
    }
  }
  @computed get isEmpty() {
    return !this.items.length;
  }
  loadIfEmpty() {
    if (this.isEmpty) {
      if (this.noPaging) this.refresh();
      else this.load();
    }
  }

  loadIfEmptyElseRefresh() {
    if (this.isEmpty) {
      this.load();
    } else {
      this.refresh();
    }
  }

  @action load = () => {
    if (this.loading || this.refreshing || this.noPaging || !this.hasMore) {
      return;
    }
    this.loading = true;
    let vars: V & PagingVars = {
      ...(this.variables as V),
      ...this.getPagingVars(),
    };
    this.doFetch(vars)
      .then((items) => {
        if (this.log) console.log("Fetch Result", items);
        this.finishLoad(items);
      })
      .catch((err) => this._log("LoadError", err));
  };

  private _log(...args: any[]) {
    console.log(`List::${this.name}`, ...args);
  }

  @action private finishLoad(items: T[]) {
    items = _.filter(items, (it) => !this.ids.has(it.id));
    let hasMore = items.length >= this.pageSize;
    this.hasMore = hasMore;
    this.items.push(...items);
    this.loading = false;
    this._addChunks(items);
  }

  @action private _addChunks(items: T[], replace = false) {
    if (!this.chunking) return;
    if (replace) {
      this._chunked = List.chunkItems(items, this.chunking);
    } else {
      let chunkIndex = 0;
      if (this._chunked.length > 0) {
        let lastChunkSize = this._chunked[this._chunked.length - 1].length;
        let lastChunkSizeIndex = this.chunking.findIndex(
          (it) => it == lastChunkSize
        );
        if (lastChunkSizeIndex > -1) {
          chunkIndex = lastChunkSizeIndex + 1;
          if (chunkIndex == this.chunking.length) {
            chunkIndex = 0;
          }
        }
      }
      this._chunked.push(...List.chunkItems(items, this.chunking, chunkIndex));
    }
  }

  @action reset = () => {
    this.pagingStarted = new Date().toISOString();
    this.hasMore = true;
    this.items.clear();
  };

  getPagingVars(): PagingVars {
    let offset = this.items.length;
    return {
      limit: this.pageSize,
      offset: offset,
    };
  }

  @action refresh = () => {
    if (this.refreshing) return;
    if (this.clearOnRefresh) this.items.clear();
    this.pagingStarted = new Date().toISOString();
    this.refreshing = true;
    this.hasMore = true;
    let vars: PagingVars = {
      ...this.variables,
      offset: 0,
      limit: this.pageSize,
    };
    // if (!this.noPaging) {
    // vars.limit = this.pageSize;
    // vars.offset = 0;
    // vars.pagingStarted = this.pagingStarted;
    // }
    let p;
    if (this.beforeRefresh) {
      p = this.beforeRefresh();
    } else {
      p = Promise.resolve(null);
    }
    return p
      .then(() => {
        this.doFetch(vars as any)
          .then((items) => {
            if (this.sort) items = this.sort(items);
            if (this.log) console.log("Fetch result", items);
            this.onFinishRefresh(items);
            return items;
          })
          .catch((err) => {
            this.onFailRefresh();
            this._log("RefreshError", err);
          });
      })
      .catch((err) => this._log("PrefetchError", err));
  };

  @action private onFailRefresh() {
    this.refreshing = false;
  }

  cache: {
    [key: string]: SearchObservable<any, T>;
  } = {};

  clearSearchCache() {
    this.cache = {};
  }

  search(term: string) {
    return (
      this.cache[term] ||
      (this.cache[term] = new SearchObservable(
        this.doSearch!.remote(term),
        this.doSearch!.local(term)
      ))
    );
  }

  hasMoreAttempts = 0;
  @action private onFinishRefresh(items: T[]) {
    items = _.uniqBy(items, "id");
    this.items.replace(items);
    this.refreshing = false;
    if (items.length >= this.pageSize) {
      this.hasMore = true;
    } else {
      this.hasMore = false;
    }
    this._addChunks(items, true);
    this.afterRefresh && this.afterRefresh();
  }

  @action updateVars(v: Partial<V>, noRefresh = false) {
    _.assign(this.variables, v);
    if (!noRefresh) this.refresh();
  }

  static chunkItems<T>(items: T[], chunking: number[], startIndex = 0): T[][] {
    let res: T[][] = [];
    let chunkIndex = startIndex;
    let current: T[] | null = null;
    for (let i = 0; i < items.length; i++) {
      let chunkSize = chunking[chunkIndex];
      if (!current) {
        current = [];
        res.push(current);
      }
      current.push(items[i]);
      if (current.length == chunkSize) {
        current = null;
        chunkIndex++;
        if (chunkIndex == chunking.length) chunkIndex = 0;
      }
    }
    return res;
  }
}
