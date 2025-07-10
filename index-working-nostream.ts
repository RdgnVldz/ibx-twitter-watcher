import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import { setIntervalAsync } from "set-interval-async";
import { Readable } from "stream";  // Import Readable from stream module

// Load environment variables
dotenv.config();

// Configuration
const X_API_V2_BASE_URL = "https://api.twitter.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const LAST_ID_FILE = "./last_id.txt";
const POLL_INTERVAL_MS = 30 * 1000;  // 30 seconds for testing
const MAX_STREAM_RECONNECT_ATTEMPTS = 5;
const X_BOT_BACKEND_URL = process.env.X_BOT_BACKEND_URL || "";
const LOGGED_USER_ID = "1654404334736777216";

let cycleCount = 0;  // This will keep track of the polling cycles

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

// Define the response type for the search API
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

// Define the response type for stream rule listing
interface StreamRulesResponse {
  data: { id: string }[];
}

// Function to delete last_id.txt if it exists
async function deleteLastIdFile(): Promise<void> {
  try {
    await fs.unlink(LAST_ID_FILE);
    console.log("Deleted existing last_id.txt file.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {  // Type assertion to check error code
      console.error("Error deleting last_id.txt:", error);
    }
  }
}

// Function to load the last ID from the file
async function loadLastId(): Promise<string | null> {
  try {
    const id = await fs.readFile(LAST_ID_FILE, "utf8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

// Function to save the latest tweet ID to last_id.txt
async function saveLastId(id: string): Promise<void> {
  if (!/^[0-9]+$/.test(id)) {
    console.warn("Skipping save: invalid tweet ID:", id);
    return;
  }
  try {
    await fs.writeFile(LAST_ID_FILE, id);
    console.log(`Saved tweet ID ${id} to last_id.txt`);
  } catch (error) {
    console.error("Error saving last ID:", error);
  }
}

async function waitForRateLimitReset(resetTime: number, attempt: number = 1): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const delay = Math.max((resetTime - now) * 1000, 0) + attempt * 1000;
  console.log(`Rate limit hit. Waiting ${delay / 1000} seconds...`);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function getUserId(accountHandle: string): Promise<string | null> {
  try {
    const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
    const response = await axios.get(
      `${X_API_V2_BASE_URL}/users/by/username/${cleanHandle}`,
      {
        headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      }
    ) as { data: { data: { id: string } } };
    return response.data.data.id;
  } catch (error: any) {
    console.error("Error fetching user ID:", error.message);
    return null;
  }
}

function shouldReplyToTweet(tweet: XTweet, targetUserId: string, targetHandle: string): boolean {
  if (tweet.author_id === targetUserId || tweet.author_id === LOGGED_USER_ID) return false;
  const mentionsTarget = tweet.text.toLowerCase().includes(`@${targetHandle.toLowerCase()}`);
  const isReplyToTarget = tweet.in_reply_to_user_id === targetUserId;
  return mentionsTarget || isReplyToTarget;
}

// Function to delete existing stream rules
async function deleteStreamRules(): Promise<void> {
  try {
    const response = await axios.get(`${X_API_V2_BASE_URL}/tweets/search/stream/rules`, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    }) as StreamRulesResponse;  // Type assertion here

    if (response.data && response.data.length > 0) {
      const ruleIds = response.data.map((rule: { id: string }) => rule.id);
      await axios.post(
        `${X_API_V2_BASE_URL}/tweets/search/stream/rules`,
        { delete: { ids: ruleIds } },
        {
          headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
        }
      );
      console.log("Deleted existing stream rules.");
    }
  } catch (error: any) {
    console.error("Error deleting stream rules:", error.message);
  }
}

// Function to set stream rules for mentions and replies to @liora_ai
async function setStreamRules(accountHandle: string): Promise<boolean> {
  const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
  try {
    await deleteStreamRules();  // Delete any existing rules first

    const response = await axios.post(
      `${X_API_V2_BASE_URL}/tweets/search/stream/rules`,
      {
        add: [
          { value: `@${cleanHandle}`, tag: "mentions" },
          { value: `to:${cleanHandle}`, tag: "replies" },
        ],
      },
      {
        headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      }
    );
    console.log("Stream rules set successfully:", response.data);
    return true;
  } catch (error: any) {
    console.error("Error setting stream rules:", error.message);
    return false;
  }
}

// Function to start streaming tweets based on the rules
async function streamTweets(accountHandle: string): Promise<void> {
  const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
  const url = `${X_API_V2_BASE_URL}/tweets/search/stream`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    params: {
      "tweet.fields": "created_at,in_reply_to_user_id",
      "user.fields": "username,name",
      "expansions": "author_id",
    },
    responseType: "stream",
  });

  console.log("Streaming tweets...");

  // Fix the issue by asserting the correct type for 'data'
  (response.data as Readable).on("data", (data: Buffer) => {
    const tweetData = JSON.parse(data.toString()) as { data?: XTweet };  // Type assertion here
    if (tweetData.data) {
      const tweet = tweetData.data;  // This is now properly typed as XTweet
      console.log(`[STREAM] @${tweet.author_id}: ${tweet.text}`);
    }
  });

  (response.data as Readable).on("error", (err: any) => {
    console.error("Streaming error:", err);
  });
}

// Fetch tweets in real-time
async function fetchRecentTweets(
  query: string,
  sinceId?: string | null
): Promise<{
  tweets: XTweet[];
  users: { [id: string]: { username: string; name: string } };
  rateLimit: RateLimitStatus | null;
}> {
  try {
    const params: any = {
      query,
      "tweet.fields": "created_at,in_reply_to_user_id",
      "user.fields": "username,name",
      max_results: 100,
      expansions: "author_id",
    };

    if (sinceId && !isNaN(Number(sinceId))) {
      params.since_id = sinceId;
    }

    const response = await axios.get(`${X_API_V2_BASE_URL}/tweets/search/recent`, {
      params,
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });

    // Fix the issue by asserting the correct type for 'data'
    const data = response.data as SearchResponse; // Type assertion here

    const rateLimit: RateLimitStatus = {
      remaining: parseInt(response.headers["x-rate-limit-remaining"] || "0"),
      reset: parseInt(response.headers["x-rate-limit-reset"] || "0"),
    };

    const users = (data.includes?.users || []).reduce((acc: any, user: any) => {
      acc[user.id] = { username: user.username, name: user.name };
      return acc;
    }, {});

    return { tweets: data.data || [], users, rateLimit };
  } catch (error: any) {
    console.error("Error fetching recent tweets:", error.message);
    return { tweets: [], users: {}, rateLimit: null };
  }
}

async function replyWithLoggedUser(tweetId: string, authorId: string) {
  try {
    const url = `${X_BOT_BACKEND_URL}/reply`;
    const response = await axios.post(url, {
      loggedUserId: LOGGED_USER_ID,
      replyToTweetId: tweetId,
      useAI: true,
      customPrompt: `The author of the tweet is ${authorId}`,
      text: "",
    });
    console.log(`✅ Reply sent to tweet ${tweetId}`);
  } catch (error: any) {
    console.error(`❌ Failed to reply to tweet ${tweetId}:`, error.message);
  }
}

async function monitorXData(accountHandle: string): Promise<void> {
  const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
  const encodedQuery = `@${cleanHandle}`;
  let lastId = await loadLastId();

  const userId = await getUserId(cleanHandle);
  console.log("userId: ", userId);
  if (!userId) {
    console.error("Failed to get user ID. Exiting.");
    return;
  }

  cycleCount++;  // Increment the cycle count
  console.log("==============================================");
  console.log(`Cycle #${cycleCount}`);
  console.log("==============================================");

  // If last_id.txt exists, delete it
  await deleteLastIdFile();

  console.log("Fetching initial tweets...");
  const { tweets, users } = await fetchRecentTweets(encodedQuery, lastId);

  if (tweets.length > 0) {
    // Save the most recent tweet's ID to last_id.txt
    lastId = tweets[0].id;
    await saveLastId(lastId);
  } else {
    console.log("No tweets found, continuing to listen...");
  }

  for (const tweet of tweets) {
    const user = users[tweet.author_id];
    const isReply = tweet.in_reply_to_user_id === userId;
    console.log(`[${tweet.created_at}] @${user.username}${isReply ? " (reply)" : ""}: ${tweet.text}`);

    if (shouldReplyToTweet(tweet, userId, cleanHandle)) {
      console.log(`🤖 Auto-replying to tweet from @${user.username}`);
      await replyWithLoggedUser(tweet.id, tweet.author_id);
    }
  }

  const rulesSet = await setStreamRules(cleanHandle);
  if (rulesSet) {
    await streamTweets(cleanHandle);
  }

  console.log("Starting fallback polling...");
  const poll = async () => {
    try {
      const { tweets, users, rateLimit } = await fetchRecentTweets(encodedQuery, lastId);
      if (tweets.length > 0) {
        for (const tweet of tweets) {
          const user = users[tweet.author_id];
          const isReply = tweet.in_reply_to_user_id === userId;
          console.log(`[${tweet.created_at}] @${user.username}${isReply ? " (reply)" : ""}: ${tweet.text}`);

          if (shouldReplyToTweet(tweet, userId, cleanHandle)) {
            console.log(`🤖 Auto-replying to tweet from @${user.username}`);
            await replyWithLoggedUser(tweet.id, tweet.author_id);
          }

          if (!lastId || BigInt(tweet.id) > BigInt(lastId)) {
            lastId = tweet.id;
            await saveLastId(lastId);
          }
        }
      }
      if (rateLimit) {
        console.log(
          `Rate limit: ${rateLimit.remaining} remaining, resets at ${new Date(rateLimit.reset * 1000)}`
        );
      }
    } catch (error: any) {
      console.error("Polling error:", error.message);
    }
  };

  await poll();
  setIntervalAsync(poll, POLL_INTERVAL_MS);
}

const targetAccount = "@liora_ai";
monitorXData(targetAccount).catch((error) => console.error("Fatal error:", error));
