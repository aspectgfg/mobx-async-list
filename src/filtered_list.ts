import _ from "lodash";
import { action, computed, observable, runInAction } from "mobx";
import { ItemType, List, ListInit, PagingVars } from "./list";

type VarsNoPaging<V> = Omit<V, keyof PagingVars>;

type FilteredListInit<T extends ItemType, V extends {}> = Omit<
  ListInit<T, V>,
  "query" | "keyPath" | "noPaging"
> & {
  filters: Filter<T, VarsNoPaging<V>, keyof VarsNoPaging<V>>[];
};

type Filter<T, V, K extends keyof V = keyof V> = {
  key?: keyof T;
  var: K;
  localFilter?: (items: T[], val: V[K]) => T[];
};

export class FilteredList<T extends ItemType, V extends {}> {
  props: FilteredListInit<T, V>;
  @observable vars: VarsNoPaging<V> = this.props.variables;
  filters: Filter<T, VarsNoPaging<V>>[];
  @computed get filterKey(): string {
    return (
      _(this.vars)
        .pick(..._.map(this.filters, "var"))
        .toPairs()
        .filter((it) => !!it[1])
        .sortBy(0)
        .map(([key, v]) => `${key}=${JSON.stringify(v)}`)
        .value()
        .join("&") || "default"
    );
  }
  @computed get isDefault() {
    return this.filterKey === "default";
  }
  @computed get list(): List<T, V> {
    let list = this.lists[this.filterKey];
    return list!;
  }

  applyFilter(items: T[]) {
    return _.filter(
      items,
      (item) =>
        !_.find(
          this.filters,
          (filter) =>
            // @ts-ignore
            this.vars[filter.var] && item[filter.key] != this.vars[filter.var]
        )
    );
  }

  @action deleteItem(id: number) {
    _.forEach(this.lists, (list) => list.removeItem(id));
  }

  @action updateVars(vars: Partial<V>) {
    this.vars = { ...this.vars, ...vars };
    if (!this.lists[this.filterKey]) {
      let list = new List({ ...this.props, variables: this.vars });
      this.lists[this.filterKey] = list;
    }
    this.list.loadIfEmpty();
  }

  @computed get isFilterWithSort() {
    if (this.isDefault) return false;
    let filterKeys = _.filter(this.filters, (it) => !it.localFilter);
    if (filterKeys.length) return false;
    return !!_.find(this.filters, (it) => !!it.localFilter);
  }

  @computed get byLocalFilter(): T[] {
    let def = this.lists.default.items;
    let ret: T[] = [...def];
    // @ts-ignore
    _.each(
      this.filters,
      (it) => (ret = it.localFilter!(ret, this.vars[it.var]))
    );
    return ret;
  }

  @computed get items(): T[] {
    let items = this.list.items;
    if (!items.length) {
      if (!this.isDefault && this.isFilterWithSort) {
        return this.byLocalFilter;
      }
    }
    return items;
  }

  lists: { [key: string]: List<T, V> } = {};

  constructor(props: FilteredListInit<T, V>) {
    this.props = props;
    this.filters = props.filters;
    runInAction(() => {
      this.vars = props.variables;
      this.lists[this.filterKey] = new List({ ...props });
    });
  }
}
