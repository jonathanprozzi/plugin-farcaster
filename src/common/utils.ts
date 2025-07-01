import {
  IAgentRuntime,
  Memory,
  stringToUuid,
  UUID,
  createUniqueUuid,
} from '@elizaos/core';
import type { Cast as NeynarCast } from '@neynar/nodejs-sdk/build/api';
import { FARCASTER_SOURCE } from './constants';
import { Cast } from './types';

export const MAX_CAST_LENGTH = 1024; // Farcaster cast character limit

export function castId({ hash, agentId }: { hash: string; agentId: string }) {
  return `${hash}-${agentId}`;
}

export function castUuid(props: { hash: string; agentId: string }) {
  return stringToUuid(castId(props));
}

export function splitPostContent(
  content: string,
  maxLength: number = MAX_CAST_LENGTH
): string[] {
  const paragraphs = content.split('\n\n').map((p) => p.trim());
  const posts: string[] = [];
  let currentCast = '';

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;

    if ((currentCast + '\n\n' + paragraph).trim().length <= maxLength) {
      if (currentCast) {
        currentCast += '\n\n' + paragraph;
      } else {
        currentCast = paragraph;
      }
    } else {
      if (currentCast) {
        posts.push(currentCast.trim());
      }
      if (paragraph.length <= maxLength) {
        currentCast = paragraph;
      } else {
        // Split long paragraph into smaller chunks
        const chunks = splitParagraph(paragraph, maxLength);
        posts.push(...chunks.slice(0, -1));
        currentCast = chunks[chunks.length - 1];
      }
    }
  }

  if (currentCast) {
    posts.push(currentCast.trim());
  }

  return posts;
}

export function splitParagraph(paragraph: string, maxLength: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + ' ' + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += ' ' + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        // Split long sentence into smaller pieces
        const words = sentence.split(' ');
        currentChunk = '';
        for (const word of words) {
          if ((currentChunk + ' ' + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += ' ' + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export function lastCastCacheKey(fid: number) {
  return `farcaster/${fid}/lastCast`;
}

export function neynarCastToCast(neynarCast: NeynarCast): Cast {
  return {
    hash: neynarCast.hash,
    authorFid: neynarCast.author.fid,
    text: neynarCast.text,
    threadId: neynarCast.thread_hash ?? undefined,
    profile: {
      fid: neynarCast.author.fid,
      name: neynarCast.author.display_name || 'anon',
      username: neynarCast.author.username,
    },
    ...(neynarCast.parent_hash && neynarCast.parent_author?.fid
      ? {
          inReplyTo: {
            hash: neynarCast.parent_hash,
            fid: neynarCast.parent_author.fid,
          },
        }
      : {}),
    timestamp: new Date(neynarCast.timestamp),
  };
}

export function createCastMemory({
  roomId,
  senderId,
  runtime,
  cast,
}: {
  roomId: UUID;
  senderId: UUID;
  runtime: IAgentRuntime;
  cast: Cast;
}): Memory {
  const inReplyTo = cast.inReplyTo
    ? castUuid({
        hash: cast.inReplyTo.hash,
        agentId: runtime.agentId,
      })
    : undefined;

  return {
    id: castUuid({
      hash: cast.hash,
      agentId: runtime.agentId,
    }),
    agentId: runtime.agentId,
    entityId: senderId,
    content: {
      text: cast.text,
      source: FARCASTER_SOURCE,
      url: '',
      inReplyTo,
      hash: cast.hash,
      threadId: cast.threadId,
    },
    roomId,
  };
}

export function formatCastTimestamp(timestamp: Date): string {
  return timestamp.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Extract FID from UUID entityId (reverse of createUniqueUuid)
 * This is a utility to get back the original FID from the UUID
 */
export function extractFidFromEntityId(
  entityId: string,
  runtime: IAgentRuntime
): number | null {
  try {
    // Try to find the FID by checking cached values or reverse-engineering
    // This is a workaround since createUniqueUuid is not easily reversible

    // Method 1: Check if it's a simple FID pattern
    const fidMatch = entityId.match(/^(\d+)/);
    if (fidMatch) {
      const fid = parseInt(fidMatch[1], 10);
      if (fid > 0 && fid < 1000000) {
        // Reasonable FID range
        return fid;
      }
    }

    // Method 2: Could store a mapping in cache if needed
    // For now, return null if we can't extract it
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Create a Memory object with FID easily accessible
 */
export function createFarcasterMemory({
  cast,
  runtime,
  roomId,
}: {
  cast: Cast;
  runtime: IAgentRuntime;
  roomId: UUID;
}): Memory {
  const entityId = createUniqueUuid(runtime, cast.authorFid.toString());

  return {
    id: castUuid({ hash: cast.hash, agentId: runtime.agentId }),
    agentId: runtime.agentId,
    entityId,
    roomId,
    content: {
      text: cast.text,
      source: FARCASTER_SOURCE,
      metadata: {
        fid: cast.authorFid,
        authorFid: cast.authorFid,
        castHash: cast.hash,
        threadId: cast.threadId,
        username: cast.profile.username,
        displayName: cast.profile.name,
      },
    },
    createdAt: cast.timestamp.getTime(),
    // DIRECT FID ACCESS
    fid: cast.authorFid,
  } as Memory;
}

/**
 * Get sender FID data from runtime cache using message ID
 * This is the reliable way to get FID data from consuming code
 */
export async function getSenderFidData(
  runtime: IAgentRuntime,
  messageId: UUID
): Promise<{
  fid: number;
  authorFid: number;
  username: string;
  displayName: string;
  castHash: string;
} | null> {
  try {
    const fidCacheKey = `farcaster:fid:${messageId}`;
    const cached = (await runtime.getCache(fidCacheKey)) as any;
    if (cached && cached.fid) {
      return cached;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract FID from message using multiple fallback methods
 * This is the ONE function your consuming code should use
 */
export async function extractSenderFid(
  runtime: IAgentRuntime,
  message: Memory
): Promise<number | null> {
  try {
    // Method 1: Get from cache (most reliable)
    if (message.id) {
      const fidData = await getSenderFidData(runtime, message.id);
      if (fidData?.fid) {
        return fidData.fid;
      }
    }

    // Method 2: Check if it's stored in content metadata
    const metadata = (message.content as any)?.metadata;
    if (metadata?.fid) {
      return metadata.fid;
    }
    if (metadata?.authorFid) {
      return metadata.authorFid;
    }

    // Method 3: Check top-level properties
    if ((message as any).fid) {
      return (message as any).fid;
    }

    // Method 4: Try to parse from entityId (last resort)
    if (message.entityId) {
      return extractFidFromEntityId(message.entityId, runtime);
    }

    return null;
  } catch (error) {
    return null;
  }
}
