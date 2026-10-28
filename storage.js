export class RecordStore {
  db=null;
  async open(){
    this.db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('mopod-v5',1);
      request.onupgradeneeded=()=>{
        request.result.createObjectStore('records',{keyPath:'id'});
        request.result.createObjectStore('rounds',{keyPath:['recordId','roundNumber']});
      };
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    // A run that survived a browser close is an interrupted run, not completed.
    for(const record of await this.list())if(record.status==='running'){record.status='interrupted';await this.save(record);}
  }
  transaction(store,mode,action){
    if(!this.db)return Promise.reject(new Error('Local record storage is unavailable.'));
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(store,mode);let output;
      const request=action(tx.objectStore(store));
      if(request)request.onsuccess=()=>{output=request.result;};
      tx.oncomplete=()=>resolve(output);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Storage transaction aborted.'));
    });
  }
  save(record){return this.transaction('records','readwrite',store=>store.put(record));}
  saveRound(recordId,roundNumber,samples){return this.transaction('rounds','readwrite',store=>store.put({recordId,roundNumber,samples}));}
  async list(){return (await this.transaction('records','readonly',store=>store.getAll())).sort((a,b)=>b.startedAt-a.startedAt);}
  get(id){return this.transaction('records','readonly',store=>store.get(id));}
  rounds(id){return this.transaction('rounds','readonly',store=>store.getAll(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER])));}
  async delete(id){await this.transaction('records','readwrite',store=>store.delete(id));await this.transaction('rounds','readwrite',store=>store.delete(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER])));}
  async clear(){await this.transaction('records','readwrite',store=>store.clear());await this.transaction('rounds','readwrite',store=>store.clear());}
}
