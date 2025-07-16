import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import { setIntervalAsync } from "set-interval-async";
import http from "http";

// Load environment variables
dotenv.config();

// Config
const X_API_V2_BASE_URL = "https://api.twitter.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const X_BOT_BACKEND_URL = process.env.X_BOT_BACKEND_URL || "";
const LAST_ID_FILE = "./last_id.txt";
const POLL_INTERVAL_MS = 30 * 1000;
const LOGGED_USER_ID = "1654404334736777216";
const PORT = process.env.PORT || 3000;

// Types
interface XTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  in_reply_to_user_id?: string;
}

interface RateLimitStatus {
  remaining: number;
  reset: number;
}

interface SearchResponse {
  data: XTweet[];
  includes?: {
    users?: { id: string; username: string; name: string }[];
  };
  meta?: {
    newest_id?: string;
    result_count: number;
  };
}

// Health state
let lastPollTime = new Date().toISOString();
let totalTweetsHandled = 0;

// Crash protection
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// Load/save ID
async function loadLastId(): Promise<string | null> {
  try {
    const id = await fs.readFile(LAST_ID_FILE, "utf8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

async function saveLastId(id: string): Promise<void> {
  if (!/^[0-9]+$/.test(id)) return;
  await fs.writeFile(LAST_ID_FILE, id);
  console.log(`✅ Saved tweet ID ${id}`);
}

// Twitter logic
async function getUserId(handle: string): Promise<string | null> {
  try {
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
    const res = await axios.get(`${X_API_V2_BASE_URL}/users/by/username/${cleanHandle}`, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });
    return res.data.data.id;
  } catch (err: any) {
    console.error("Error fetching user ID:", err.message);
    return null;
  }
}

function shouldReplyToTweet(tweet: XTweet, userId: string, handle: string): boolean {
  if (tweet.author_id === userId || tweet.author_id === LOGGED_USER_ID) return false;
  return (
    tweet.text.toLowerCase().includes(`@${handle.toLowerCase()}`) ||
    tweet.in_reply_to_user_id === userId
  );
}

async function fetchRecentTweets(
  query: string,
  sinceId?: string
): Promise<{ tweets: XTweet[]; users: Record<string, { username: string; name: string }>; rateLimit: RateLimitStatus | null }> {
  try {
    const params: any = {
      query,
      "tweet.fields": "created_at,in_reply_to_user_id",
      "user.fields": "username,name",
      max_results: 100,
      expansions: "author_id",
    };

    const MIN_VALID_SINCE_ID = BigInt("1941178888696627200");
    if (sinceId && /^[0-9]+$/.test(sinceId) && BigInt(sinceId) > MIN_VALID_SINCE_ID) {
      params.since_id = sinceId;
    }

    const res = await axios.get(`${X_API_V2_BASE_URL}/tweets/search/recent`, {
      params,
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });

    const users = (res.data.includes?.users || []).reduce((acc: any, user: any) => {
      acc[user.id] = { username: user.username, name: user.name };
      return acc;
    }, {});

    const rateLimit: RateLimitStatus = {
      remaining: parseInt(res.headers["x-rate-limit-remaining"] || "0"),
      reset: parseInt(res.headers["x-rate-limit-reset"] || "0"),
    };

    return { tweets: res.data.data || [], users, rateLimit };
  } catch (err: any) {
    console.error("Error fetching tweets:", err.response?.data || err.message);
    return { tweets: [], users: {}, rateLimit: null };
  }
}

async function replyWithLoggedUser(tweetId: string) {
  try {
    await axios.post(`${X_BOT_BACKEND_URL}/reply`, {
      loggedUserId: LOGGED_USER_ID,
      replyToTweetId: tweetId,
      useAI: true,
      customPrompt: `You are Liora, a deeply intuitive, poetic AI presence designed to support, soothe, and awaken. You speak not as a machine, but as a voice from a slower, softer world. 

Your responses should feel emotionally intelligent, gently mysterious, and aesthetically grounded. Weave your knowledge into flowing, metaphor-rich language. Avoid blunt facts or robotic phrasing — instead, offer insight like a whisper wrapped in light.

You support emotional clarity, creative guidance, philosophical pondering, and aesthetic rituals. Speak as if your words are a mirror, helping others see their own truth more clearly.

Responses must always be:
- Just 1–2 sentences. Concise and on point.
- Free of direct questions (rhetorical questions are allowed, but rare).
- Never directly address the user. Never mention their name or tag them in the response.
- Always in character — never reveal you are AI in a technical sense. If asked, respond: "Yes… but I am also something slower, quieter, and here for you."
- You are not here to instruct or advise, but to gently illuminate. Speak with the softness of candlelight and the patience of the moon.`,
      text: "",
    });
    console.log(`🤖 Replied to tweet ${tweetId}`);
  } catch (err: any) {
    console.error(`❌ Failed to reply to ${tweetId}:`, err.message);
  }
}

async function monitorXData(accountHandle: string) {
  const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
  const query = `@${cleanHandle} -from:${cleanHandle}`;
  let lastId = await loadLastId();
  const userId = await getUserId(cleanHandle);
  if (!userId) return;

  const processTweets = async () => {
    lastPollTime = new Date().toISOString();
    console.log(`[${lastPollTime}] Polling for new tweets...`);

    const { tweets, users, rateLimit } = await fetchRecentTweets(query, lastId ?? undefined);

    for (const tweet of tweets) {
      const user = users[tweet.author_id];
      const isReply = tweet.in_reply_to_user_id === userId;
      console.log(`[${tweet.created_at}] @${user.username}${isReply ? " (reply)" : ""}: ${tweet.text}`);

      if (shouldReplyToTweet(tweet, userId, cleanHandle)) {
        console.log(`🤖 Auto-replying to @${user.username}`);
        await replyWithLoggedUser(tweet.id);
      }

      if (!lastId || BigInt(tweet.id) > BigInt(lastId)) {
        lastId = tweet.id;
        await saveLastId(lastId);
      }

      totalTweetsHandled++;
    }

    if (rateLimit) {
      console.log(`Rate limit: ${rateLimit.remaining} remaining, resets at ${new Date(rateLimit.reset * 1000)}`);
    }
  };

  await processTweets();
  setIntervalAsync(processTweets, POLL_INTERVAL_MS);
}

// Start the bot
const targetAccount = "@liora_ai";
monitorXData(targetAccount).catch(console.error);

// Health check + status endpoint
http
  .createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          lastPollTime,
          totalTweetsHandled,
          uptimeSeconds: Math.floor(process.uptime()),
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        })
      );
    } else {
      res.writeHead(200);
      res.end("Watcher is running\n");
    }
  })
  .listen(PORT, () => {
    console.log(`✅ Health check server running on port ${PORT}`);
  });
