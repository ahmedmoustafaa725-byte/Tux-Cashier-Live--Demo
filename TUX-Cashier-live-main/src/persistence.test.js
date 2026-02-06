import { packStateForCloud, unpackStateFromCloud } from "./App";

describe("state persistence helpers", () => {
  it("preserves realtimeOrders flag and converts dates when packing/unpacking", () => {
    const sampleDate = new Date("2024-02-03T04:05:06.000Z");
    const state = {
      menu: [{ id: "m1", name: "Burger" }],
      extraList: [{ id: "e1", name: "Cheese" }],
      orders: [
        {
          orderNo: 1,
          worker: "Alice",
          payment: "Cash",
          paymentParts: [{ method: "Cash", amount: 12 }],
          orderType: "dine_in",
          deliveryFee: 0,
          total: 12,
          itemsTotal: 12,
          cashReceived: 20,
          changeDue: 8,
          done: true,
          voided: false,
          note: "Thanks",
          date: sampleDate,
          restockedAt: sampleDate,
          cart: [],
        },
      ],
      inventory: [{ id: "i1", name: "Patty" }],
      nextOrderNo: 2,
      workerProfiles: [{ id: "w1", name: "Alice" }],
      workerSessions: [
        { id: "s1", name: "Alice", signInAt: sampleDate, signOutAt: sampleDate },
      ],
      dark: true,
      workers: [{ id: "w1", name: "Alice" }],
      paymentMethods: ["Cash", "Card"],
      inventoryLocked: false,
      inventorySnapshot: [{ id: "i1", qty: 3 }],
      inventoryLockedAt: sampleDate,
      adminPins: { alice: "1234" },
      orderTypes: [{ id: "ot1", name: "Dine in" }],
      defaultDeliveryFee: 5,
      expenses: [{ id: "ex1", amount: 10, date: sampleDate }],
      purchases: [{ id: "p1", amount: 50, date: sampleDate }],
      purchaseCategories: [{ id: "cat1", name: "Food" }],
      customers: [
        {
          id: "c1",
          lastOrderAt: sampleDate,
          firstOrderAt: sampleDate,
          updatedAt: sampleDate,
        },
      ],
      deliveryZones: [{ id: "z1", name: "Zone" }],
      dayMeta: {
        startedAt: sampleDate,
        endedAt: sampleDate,
        lastReportAt: sampleDate,
        resetAt: sampleDate,
        reconciledAt: sampleDate,
        shiftChanges: [{ at: sampleDate }],
      },
      bankTx: [{ id: "b1", date: sampleDate, amount: 100 }],
      reconHistory: [{ id: "r1", at: sampleDate }],
      realtimeOrders: false,
        onlineOrdersRaw: [
        {
          id: "o1",
          createdAt: sampleDate,
          createdAtMs: sampleDate.getTime(),
          date: sampleDate,
          restockedAt: sampleDate,
          whatsappSentAt: sampleDate,
          total: 42,
          itemsTotal: 40,
          deliveryFee: 2,
          cart: [
            {
              id: "c1",
              name: "Burger",
              qty: 1,
              price: 40,
              extras: [],
            },
          ],
          status: "new",
          source: "online",
          channel: "online",
        },
      ],
      onlineOrderStatus: {
        "o1": { state: "imported", lastUpdateAt: 123, lastSeenAt: 456 },
      },
      lastSeenOnlineOrderTs: sampleDate.getTime(),
    };

    const packed = packStateForCloud(state);

    expect(packed.realtimeOrders).toBe(false);
  expect(packed.workerSessions[0].signInAt).toEqual(sampleDate.toISOString());
    expect(packed.onlineOrders[0].createdAt).toEqual(sampleDate.toISOString());
    expect(packed.lastSeenOnlineOrderTs).toBe(sampleDate.getTime());

    const unpacked = unpackStateFromCloud(packed);

    expect(unpacked.realtimeOrders).toBe(false);
    expect(unpacked.workerSessions[0].signInAt).toBeInstanceOf(Date);
    expect(unpacked.orders[0].date).toBeInstanceOf(Date);
    expect(unpacked.onlineOrdersRaw[0].createdAt).toBeInstanceOf(Date);
    expect(unpacked.onlineOrderStatus.o1.state).toBe("imported");
    expect(unpacked.lastSeenOnlineOrderTs).toBe(sampleDate.getTime());
  });
});
