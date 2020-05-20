import { observable, runInAction } from "mobx";

export class SearchObservable<RemoteResult, LocalResults> {
  @observable fetchedResults = false;
  results = observable.array<RemoteResult>();
  local: LocalResults[];
  constructor(promise: Promise<RemoteResult[]>, local: LocalResults[]) {
    this.local = local;
    promise.then((res) => {
      runInAction(() => {
        this.fetchedResults = true;
        this.results.replace(res);
      });
    });
  }
}
