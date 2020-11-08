import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

import axios from 'axios';
// @ts-ignore
import * as sentiment from 'wink-sentiment';

axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0';
const CREDENTIAL_PATH = require('path').resolve(__dirname, '..', '.credentials', 'admin.json');

const COLLECTION_NAME = 'reddit-test';
// const FIRESTORE_HEALTH_CHECK = 'health-check';

const HOT_POST_URL = 'https://www.reddit.com/r/Crypto_com/hot.json';
const TOP_POST_URL = 'https://www.reddit.com/r/Crypto_com/top.json';
const NEW_POST_URL = 'https://www.reddit.com/r/Crypto_com/new.json?order=desc';
// const LIST_POST_URL = 'https://www.reddit.com/r/Crypto_com/.json?';

const POST_URL_MAP = new Map([
  ['hot', HOT_POST_URL],
  ['top', TOP_POST_URL],
  ['new', NEW_POST_URL],
  ['default', NEW_POST_URL],
]);

let IS_APP_INIT = false;
let db: null | FirebaseFirestore.Firestore = null;

const firebaseConfig = {
  credential: admin.credential.cert(CREDENTIAL_PATH),
  databaseURL: "https://gamma-f85e7.firebaseio.com",
};

const initApp = async(): Promise<void> => {
  log('Initialize firebase......');
  if (!IS_APP_INIT) {
    admin.initializeApp(firebaseConfig);
    IS_APP_INIT = true;
  }

  if (db === null) {
    db = admin.firestore();
  }
}

const log = (...message: any[]): void => console.log('[INFO]', ...message);
const error = (...message: any[]): void => console.log('[ERROR]', ...message);

const getId = (name: string) => name.replace(/t[0-9]_/g, '');

const fetchPost = async (url: string): Promise<number> => {
  await initApp();
  if (db === null) {
    throw new Error('Error initializing database');
  }

  log('Fetching from reddit......');
  const res = await axios.get(url);
  const data = res.data['data']['children'];
  const snapshotRef = db.collection(COLLECTION_NAME).doc('snapshot');
  const snapshot = await snapshotRef.get();

  let candidates: Array<any> = [];
  let candidateIds: Array<string> = [];
  let children: Map<string, any>;

  if (!snapshot.exists) {
    candidates = data;
    candidateIds = data.map((d: any) => getId(d['data']['name']));
    children = new Map();
  } else {
    children = new Map(Object.entries(snapshot.data()!.children));
    data.forEach((d: any) => {
      const dataId = getId(d['data']['name']);
      if (!children.has(dataId)) {
        candidates.push(d);
        candidateIds.push(dataId);
      }
    });
  }

  log('Storing to Firestore......');
  const batch = db.batch();
  candidates.forEach((d: any) => {
    const datum = d['data'];
    const id = getId(datum['name']);
    const ref = db!.collection(COLLECTION_NAME).doc(id);

    children.set(id, true);
    batch.set(ref, {
      author_id: getId(datum['author_fullname']),
      content: datum['selftext'],
      created_at: datum['created'],
      kind: 3,
      permalink: datum['permalink'],
      title: datum['title'],
    });
  });

  batch.set(snapshotRef, {
    children: Object.fromEntries(children),
  })

  await batch.commit();

  log('Finish processing.');

  return candidateIds.length;
}

export const fetchReddit = functions.https.onRequest(async(request, response) => {
  try {
    let type: undefined | string = request.query.type?.toString();
    if (type === undefined) {
      type = 'default'
    }
    await fetchPost(POST_URL_MAP.get(type)!);
    response.status(200).send('ok');
  } catch(e) {
    error(e);
    response.status(500).send(e);
  }
});

export const getSentimentScore = functions.https.onRequest(async (request, response) => {
  try {
    await initApp();
    const count = request.query.count === undefined ? 10 : parseInt(request.query.count.toString());
    const collection = db!.collection(COLLECTION_NAME);
    const candidates = await collection.orderBy('created_at', 'desc').limit(count).get();

    let score = 0;
    candidates.docs.forEach(doc => {
      const datum = doc.data();

      if (datum['content'] === '') {
        const result = sentiment(datum['title']);
        score += result.normalizedScore;
      } else {
        const result = sentiment(datum['content']);
        score += result.normalizedScore;
      }
    });
    response.status(200).send(JSON.parse('{"score": "' + score + '"}'));
  } catch(e) {
    error(e);
    response.status(500).send(e);
  }
})

// export const checkFirestore = functions.https.onRequest(async (_, response) => {
//   try {
//     initApp();
//
//     const created_at = Date.now();
//     let result = await db!.collection(FIRESTORE_HEALTH_CHECK).add({
//       created_at: created_at,
//     });
//
//     let row = await db!.collection(FIRESTORE_HEALTH_CHECK).doc(result.id).get();
//     response.status(200).send(row.data());
//   } catch(e) {
//     error(e);
//     response.status(500).send(e);
//   }
// })

// export const fetchTopPostCron = functions.pubsub.schedule('every 10 minutes').onRun(async (_) => {
//   log('Cron running - TOP');
//   await fetchPost(TOP_POST_URL)
//   return null;
// });
//

export const fetchNewPostCron = functions.pubsub.schedule('every 30 minutes').onRun(async (_) => {
  log('Cron running - NEW');
  const updatedCount = await fetchPost(NEW_POST_URL);
  log('CRON finish - updated', updatedCount, 'records');
  return null;
})

// Logic
// 1. get posts
// 2. get year and month from created timestamp
// 3. create collection if not exist (e.g. reddit-202011)
// 4. create document with name, remove kind prefix (e.g. t3_fjidos -> fjidos) if not exist
// 5. call other function to get replies? -> logic in other function
