import { graphql, rest } from "msw";
import { setupServer } from "msw/node";
import { SourceNodesArgs } from "gatsby";
import { shiftLeft } from "shift-left";

import { makeSourceFromOperation } from "../src/make-source-from-operation";
import { createOperations } from "../src/operations";
import { pluginErrorCodes } from "../src/errors";

import {
  resolve,
  resolveOnce,
  currentBulkOperation,
  startOperation,
} from "./fixtures";

const server = setupServer();

// @ts-ignore
global.setTimeout = (fn: Function) => fn();

jest.mock("gatsby-source-filesystem", () => ({
  createRemoteFileNode: jest.fn().mockResolvedValue({ id: "12345" }),
}));

beforeAll(() => {
  server.listen();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("When polling an operation", () => {
  const id = "54321";

  beforeEach(() => {
    server.use(
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolveOnce(currentBulkOperation("COMPLETED"))
      ),
      startOperation({ id }),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolveOnce({
          node: {
            status: `CREATED`,
            id: "",
            objectCount: "0",
            query: "",
            url: "",
          },
        })
      ),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolve({
          node: {
            status: `COMPLETED`,
            id: "12345",
            objectCount: "1",
            query: "",
            url: "http://results.url",
          },
        })
      ),
      rest.get("http://results.url", (_req, res, ctx) => {
        return res(
          ctx.text(JSON.stringify({ id: "gid://shopify/Product/12345" }))
        );
      })
    );
  });

  it("reports status changes", async () => {
    const setStatus = jest.fn();
    const gatsbyApiMock = jest.fn().mockImplementation(() => {
      return {
        cache: {
          set: jest.fn(),
        },
        actions: {
          createNode: jest.fn(),
        },
        createContentDigest: jest.fn(),
        createNodeId: jest.fn(),
        reporter: {
          info: jest.fn(),
          error: jest.fn(),
          panic: jest.fn(),
          activityTimer: () => ({
            start: jest.fn(),
            end: jest.fn(),
            setStatus,
          }),
        },
      };
    });

    const gatsbyApi = gatsbyApiMock as jest.Mock<SourceNodesArgs>;
    const options = {
      apiKey: ``,
      password: ``,
      storeUrl: "my-shop.shopify.com",
      downloadImages: true,
    };
    const operations = createOperations(options, gatsbyApi());

    const sourceFromOperation = makeSourceFromOperation(
      operations.finishLastOperation,
      operations.completedOperation,
      operations.cancelOperationInProgress,
      gatsbyApi(),
      options
    );

    await sourceFromOperation(operations.createProductsOperation);

    expect(setStatus).toHaveBeenCalledWith(shiftLeft`
      Polling bulk operation: ${id}
      Status: COMPLETED
      Object count: 1
    `);
  });
});

describe("When downloading images", () => {
  const bulkResult = {
    id: "gid://shopify/Product/12345",
    featuredMedia: {
      preview: {
        image: {
          originalSrc: "http://www.example.com/some-image.jpg",
        },
      },
    },
  };

  beforeEach(() => {
    server.use(
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolveOnce(currentBulkOperation("COMPLETED"))
      ),
      startOperation(),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolve({
          node: {
            status: `COMPLETED`,
            id: "",
            objectCount: "1",
            query: "",
            url: "http://results.url",
          },
        })
      ),
      rest.get("http://results.url", (_req, res, ctx) => {
        return res(ctx.text(JSON.stringify(bulkResult)));
      })
    );
  });

  it("links a local file to the featured media", async () => {
    const createNode = jest.fn();
    const gatsbyApiMock = jest.fn().mockImplementation(() => {
      return {
        cache: {
          set: jest.fn(),
        },
        actions: {
          createNode,
        },
        createContentDigest: jest.fn(),
        createNodeId: jest.fn(),
        reporter: {
          info: jest.fn(),
          error: jest.fn(),
          panic: jest.fn(),
          activityTimer: () => ({
            start: jest.fn(),
            end: jest.fn(),
            setStatus: jest.fn(),
          }),
        },
      };
    });

    const gatsbyApi = gatsbyApiMock as jest.Mock<SourceNodesArgs>;
    const options = {
      apiKey: ``,
      password: ``,
      storeUrl: "my-shop.shopify.com",
      downloadImages: true,
    };
    const operations = createOperations(options, gatsbyApi());

    const sourceFromOperation = makeSourceFromOperation(
      operations.finishLastOperation,
      operations.completedOperation,
      operations.cancelOperationInProgress,
      gatsbyApi(),
      options
    );

    await sourceFromOperation(operations.createProductsOperation, true);

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyId: bulkResult.id,
        featuredMedia: {
          preview: {
            image: expect.objectContaining({
              localFile: "12345",
            }),
          },
        },
      })
    );
  });
});

describe("A production build", () => {
  const bulkResult = { id: "gid://shopify/Product/12345" };

  beforeEach(() => {
    server.use(
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolveOnce(currentBulkOperation("RUNNING"))
      ),
      graphql.mutation<BulkOperationCancelResponse>(
        "CANCEL_OPERATION",
        resolve({
          bulkOperationCancel: {
            bulkOperation: {
              id: "",
              status: "CANCELING",
              objectCount: "0",
              url: "",
              query: "",
            },
            userErrors: [],
          },
        })
      ),
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolve(currentBulkOperation("CANCELED"))
      ),
      startOperation(),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolve({
          node: {
            status: `COMPLETED`,
            id: "",
            objectCount: "1",
            query: "",
            url: "http://results.url",
          },
        })
      ),
      rest.get("http://results.url", (_req, res, ctx) => {
        return res(ctx.text(JSON.stringify(bulkResult)));
      })
    );
  });

  it("cancels other operations in progress", async () => {
    const createNode = jest.fn();
    const gatsbyApiMock = jest.fn().mockImplementation(() => {
      return {
        cache: {
          set: jest.fn(),
        },
        actions: {
          createNode,
        },
        createContentDigest: jest.fn(),
        createNodeId: jest.fn(),
        reporter: {
          info: jest.fn(),
          error: jest.fn(),
          panic: jest.fn(),
          activityTimer: () => ({
            start: jest.fn(),
            end: jest.fn(),
            setStatus: jest.fn(),
          }),
        },
      };
    });

    const gatsbyApi = gatsbyApiMock as jest.Mock<SourceNodesArgs>;
    const options = {
      apiKey: ``,
      password: ``,
      storeUrl: "my-shop.shopify.com",
    };
    const operations = createOperations(options, gatsbyApi());

    const sourceFromOperation = makeSourceFromOperation(
      operations.finishLastOperation,
      operations.completedOperation,
      operations.cancelOperationInProgress,
      gatsbyApi(),
      options
    );

    await sourceFromOperation(operations.createProductsOperation, true);

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({ shopifyId: bulkResult.id })
    );
  });
});

describe("When an operation gets canceled", () => {
  const bulkResult = { id: "gid://shopify/Product/12345" };

  beforeEach(() => {
    server.use(
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolve(currentBulkOperation("COMPLETED"))
      ),
      startOperation(),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolveOnce({
          node: {
            status: `CANCELED`,
            id: "",
            objectCount: "0",
            query: "",
            url: "",
          },
        })
      ),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolve({
          node: {
            status: `COMPLETED`,
            id: "",
            objectCount: "1",
            query: "",
            url: "http://results.url",
          },
        })
      ),
      rest.get("http://results.url", (_req, res, ctx) => {
        return res(ctx.text(JSON.stringify(bulkResult)));
      })
    );
  });

  it("tries again", async () => {
    const createNode = jest.fn();
    const gatsbyApiMock = jest.fn().mockImplementation(() => {
      return {
        cache: {
          set: jest.fn(),
        },
        actions: {
          createNode,
        },
        createContentDigest: jest.fn(),
        createNodeId: jest.fn(),
        reporter: {
          info: jest.fn(),
          error: jest.fn(),
          panic: jest.fn(),
          activityTimer: () => ({
            start: jest.fn(),
            end: jest.fn(),
            setStatus: jest.fn(),
          }),
        },
      };
    });

    const gatsbyApi = gatsbyApiMock as jest.Mock<SourceNodesArgs>;
    const options = {
      apiKey: ``,
      password: ``,
      storeUrl: "my-shop.shopify.com",
    };
    const operations = createOperations(options, gatsbyApi());

    const sourceFromOperation = makeSourceFromOperation(
      operations.finishLastOperation,
      operations.completedOperation,
      operations.cancelOperationInProgress,
      gatsbyApi(),
      options
    );

    await sourceFromOperation(operations.createProductsOperation);

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({ shopifyId: bulkResult.id })
    );
  });
});

describe("When an operation fails with bad credentials", () => {
  beforeEach(() => {
    server.use(
      graphql.query<CurrentBulkOperationResponse>(
        "OPERATION_STATUS",
        resolve(currentBulkOperation("COMPLETED"))
      ),
      startOperation(),
      graphql.query<{ node: BulkOperationNode }>(
        "OPERATION_BY_ID",
        resolve({
          node: {
            status: `FAILED`,
            id: "",
            objectCount: "0",
            query: "",
            url: "",
            errorCode: `ACCESS_DENIED`,
          },
        })
      )
    );
  });

  it("panics and reports the error code", async () => {
    const panic = jest.fn();
    const gatsbyApiMock = jest.fn().mockImplementation(() => {
      return {
        cache: {
          set: jest.fn(),
        },
        actions: {
          createNode: jest.fn(),
        },
        reporter: {
          info: jest.fn(),
          error: jest.fn(),
          panic,
          activityTimer: () => ({
            start: jest.fn(),
            end: jest.fn(),
            setStatus: jest.fn(),
          }),
        },
      };
    });

    const gatsbyApi = gatsbyApiMock as jest.Mock<SourceNodesArgs>;
    const options = {
      apiKey: ``,
      password: ``,
      storeUrl: "my-shop.shopify.com",
    };
    const operations = createOperations(options, gatsbyApi());

    const sourceFromOperation = makeSourceFromOperation(
      operations.finishLastOperation,
      operations.completedOperation,
      operations.cancelOperationInProgress,
      gatsbyApi(),
      options
    );

    await sourceFromOperation(operations.createProductsOperation);
    expect(panic).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pluginErrorCodes.unknownSourcingFailure,
        context: {
          sourceMessage: expect.stringContaining(`ACCESS_DENIED`),
        },
      })
    );
  });
});
