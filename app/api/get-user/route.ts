import request, { gql } from "graphql-request";
import Moralis from "moralis";
import { formatEther } from "viem";

export const dynamic = "force-dynamic"; // static by default, unless reading the request
export const runtime = "nodejs";

const apiKey = process.env.STACKLY_API_KEY;

Moralis.start({
  apiKey: process.env.MORALIS_API_KEY,
});

async function findAsyncSequential<T>(
  array: T[],
  predicate: (t: T) => Promise<boolean>
): Promise<T | undefined> {
  for (const t of array) {
    if (await predicate(t)) {
      return t;
    }
  }
  return undefined;
}

export async function POST(request: Request) {
  const payload = await request.json();
  const headers = request.headers;
  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);

  const minmumValue = searchParams.get("value");
  const startTime = searchParams.get("startTime");

  if (!minmumValue || !startTime) {
    return new Response("Wrong params", { status: 400 });
  }

  const walletAddress: string = payload.accounts.wallet;

  if (apiKey !== headers.get("x-api-key")) {
    throw new Error("Invalid API Key");
  }

  const userOrders = (await getUserOrders({
    id: walletAddress.toLowerCase(),
    startTime_gte: +startTime,
  })) as {
    dcaorders: {
      amount: string;
      sellToken: { address: string; decimals: number };
    }[];
  };

  const result = await findAsyncSequential(
    userOrders.dcaorders,
    async (order) => {
      try {
        const tokenAmount = formatEther(BigInt(order.amount));
        const response = await Moralis.EvmApi.token.getTokenPrice({
          chain: "0xa4b1",
          address: order.sellToken.address,
        });

        const stackValue = response.raw.usdPrice * +tokenAmount;
        if (stackValue >= +minmumValue) return true;

        return false;
      } catch (e) {
        console.error(e);
        return false;
      }
    }
  );

  if (result === undefined) {
    return new Response("Validation failed", { status: 400 });
  }

  return new Response("Quest completed");
}

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/63508/stackly-arbitrum-one/version/latest";

const getUserOrders = (params: { id: string; startTime_gte: number }) =>
  request(SUBGRAPH_URL, getOrdersQuery, params);

const getOrdersQuery = gql`
  query GetOrders($id: ID!, $startTime_gte: Int) {
    dcaorders(where: { owner: $id, startTime_gte: $startTime_gte }) {
      id
      sellToken {
        address
        id
        symbol
        name
        decimals
      }
      amount
    }
  }
`;
