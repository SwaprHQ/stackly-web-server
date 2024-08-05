import request, { gql } from "graphql-request";
import Moralis from "moralis";
import { formatEther, formatUnits } from "viem";

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

type DCAOrder = {
  amount: string;
  sellToken: { address: string; decimals: number };
};

const ALLOWED_TOKEN_LIST = [
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
  "0x912CE59144191C1204E64559FE8253a0e49E6548", // ARB
  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC.e
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
];

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
    dcaorders: DCAOrder[];
  };

  const getUSDPriceMoralis = async (order: DCAOrder): Promise<number> => {
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: "0xa4b1",
      address: order.sellToken.address,
    });

    return response.raw.usdPrice;
  };

  const getUSDPriceMobula = async (order: DCAOrder): Promise<number> => {
    const response = await fetch(
      `https://api.mobula.io/api/1/market/data?asset=${order.sellToken.address}&blockchain=42161`,
      {
        method: "GET",
        headers: {
          Authorization: process.env.MOBULA_API_KEY || "",
        },
      }
    );

    const data = await response.json();

    return data.data.price;
  };

  const getUSDPriceCoinGecko = async (order: DCAOrder): Promise<number> => {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/arbitrum-one?contract_addresses=${order.sellToken.address}&vs_currencies=usd`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-cg-api-key": process.env.COINGECKO_API_KEY || "",
      },
    });

    const data = await response.json();

    return data[order.sellToken.address.toLowerCase()].usd;
  };

  const getUSDPricePortals = async (order: DCAOrder): Promise<number> => {
    const url = `https://api.portals.fi/v2/tokens?ids=arbitrum:${order.sellToken.address}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: process.env.PORTALS_API_KEY || "",
      },
    });

    const data = await response.json();

    return data.tokens[0].price;
  };

  const getPrice = (order: DCAOrder) => {
    const optionNumber = Math.floor(Math.random() * 100);

    // use mobula and portals more frequently since they have better plans
    if (optionNumber > 50) return getUSDPriceMobula(order);
    else if (optionNumber > 25) return getUSDPricePortals(order);
    else if (optionNumber > 10) return getUSDPriceCoinGecko(order);
    else return getUSDPriceMoralis(order);
  };

  const result = await findAsyncSequential(
    userOrders.dcaorders.filter((order) =>
      ALLOWED_TOKEN_LIST.some(
        (token) => token.toLowerCase() === order.sellToken.address.toLowerCase()
      )
    ),
    async (order) => {
      try {
        const tokenAmount = formatUnits(
          BigInt(order.amount),
          order.sellToken.decimals
        );
        const usdPrice = await getPrice(order);
        const stackValue = usdPrice * +tokenAmount;

        console.log("Checking order: ", {
          token: order.sellToken.address,
          amount: order.amount,
          walletAddress,
          usdPrice,
          stackValue,
        });

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
