/**
 * billing.js — POS / Invoicing
 *
 * POST /api/billing/invoice                  create sale invoice
 * GET  /api/billing/invoices                 list invoices (with filters)
 * GET  /api/billing/invoice/:id              single invoice detail
 * GET  /api/billing/invoice/:id/pdf          stream PDF
 * POST /api/billing/invoice/:id/send-whatsapp send PDF link via WhatsApp
 * POST /api/billing/invoice/:id/payment      record payment on credit invoice
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';
import { generateInvoicePdf } from '../services/pdf.js';
import { sendInvoiceWhatsApp } from '../services/whatsapp.js';
import { nextSeq, currentYYYYMM } from '../lib/sequence.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';
import { incrementCounter } from '../lib/metrics.js';

const router = Router();

const VALID_INVOICE_TYPES = ['RETAIL', 'CREDIT', 'ESTIMATE', 'RETURN', 'WORKSHOP', 'EXCHANGE'];

// ─── Helper: write one PartyLedger debit row (mirrors parties.js helper) ─────
async function writeLedgerDebit(tx, { shopId, partyId, creditAmount = 0, debitAmount = 0, invoiceId, entryType, notes, createdBy }) {
  // Atomic increment — avoids read-modify-write race when two invoices hit the same party concurrently
  const updated = await tx.party.update({
    where: { partyId: parseInt(String(partyId), 10) },
    data:  { outstanding: { increment: debitAmount - creditAmount } },
    select: { outstanding: true },
  });
  const balanceAfter = Number(updated.outstanding);

  await tx.partyLedger.create({
    data: { shopId, partyId, entryType, debitAmount, creditAmount, balanceAfter, invoiceId, notes, createdBy: createdBy || null },
  });

  return balanceAfter;
}

/**
 * computeItemTotals — the GST/discount math for a set of inventory line items.
 * Extracted out of createInvoice so exchanges.js can price the "new item" leg
 * of an exchange with the exact same formula, before it knows how much of the
 * old item's credit note to apply — without duplicating the math.
 */
export async function computeItemTotals(shopId, items, invType, interState = false) {
  const inventoryIds = Array.isArray(items) ? items.map(i => parseInt(i.inventoryId)) : [];
  const inventoryRows = inventoryIds.length > 0
    ? await prisma.shopInventory.findMany({
        where: { inventoryId: { in: inventoryIds }, shopId },
        include: { masterPart: true },
      })
    : [];
  const invMap = new Map(inventoryRows.map(r => [r.inventoryId, r]));

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  const processedItems = [];

  for (const item of (items || [])) {
    const inv = invMap.get(parseInt(item.inventoryId));
    if (!inv) {
      throw { status: 400, message: `Invalid inventory item: ${item.inventoryId}` };
    }

    // Pre-flight stock check — provides a user-friendly error message.
    // NOTE: the authoritative atomic guard happens inside the transaction below via
    // updateMany({ where: { stockQty: { gte: qty } } }) — this pre-flight check is
    // only for early UX feedback; it does NOT prevent the race.
    if (invType !== 'ESTIMATE' && inv.stockQty < item.qty) {
      throw { status: 400, message: `Insufficient stock for ${inv.masterPart.partName}: have ${inv.stockQty}, need ${item.qty}` };
    }

    const itemQty = parseInt(item.qty);
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      throw { status: 400, message: `Invalid quantity for ${inv.masterPart.partName}` };
    }
    const unitPrice  = parseFloat(item.unitPrice || inv.sellingPrice);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw { status: 400, message: `Invalid unit price for ${inv.masterPart.partName}` };
    }
    // Discount: non-negative, capped at 80 % of unit price (leaves at least 20 % value)
    const maxDiscount = unitPrice * 0.8;
    const discount    = Math.min(maxDiscount, Math.max(0, parseFloat(item.discount) || 0));
    const taxableAmt  = (unitPrice - discount) * itemQty;
    const gstRate    = parseFloat(inv.masterPart.gstRate || 18);
    // Place of supply: inter-state → single IGST at full rate; intra-state → CGST+SGST split.
    const itemIgst   = interState ? taxableAmt * (gstRate / 100) : 0;
    const itemCgst   = interState ? 0 : taxableAmt * (gstRate / 2 / 100);
    const itemSgst   = itemCgst;
    const itemTotal  = taxableAmt + itemCgst + itemSgst + itemIgst;

    subtotal += taxableAmt;
    cgst     += itemCgst;
    sgst     += itemSgst;
    igst     += itemIgst;

    processedItems.push({
      inventoryId: item.inventoryId,
      partName:    inv.masterPart.partName,
      brand:       inv.masterPart.brand,
      hsnCode:     inv.masterPart.hsnCode,
      oemNumber:   item.oemNumber || inv.masterPart.primaryOemNumber || (Array.isArray(inv.masterPart.oemNumbers) ? inv.masterPart.oemNumbers[0] : null),
      mrp:         item.mrp !== undefined && item.mrp !== null && item.mrp !== "" ? Number(item.mrp) : (inv.masterPart.mrp !== undefined && inv.masterPart.mrp !== null ? Number(inv.masterPart.mrp) : null),
      qty:         itemQty,
      unitPrice,
      discount,
      taxableAmt,
      gstRate,
      cgst:        itemCgst,
      sgst:        itemSgst,
      igst:        itemIgst,
      total:       itemTotal,
      buyingPrice: parseFloat(inv.buyingPrice || 0),
    });
  }

  return { subtotal, cgst, sgst, igst, processedItems };
}

/**
 * createInvoice — the full invoice-creation transaction, extracted so it can be
 * called both from POST /api/billing/invoice (below) AND from the Exchange flow
 * (exchanges.js), which needs to create the "new item" sale as one leg of an
 * exchange while redeeming the just-created credit note from the "old item"
 * return. Throws { status, message } on validation failure — callers convert
 * that to an HTTP response; anything else propagates as a real error.
 *
 * `correlationId`, if given, tags every Movement this invoice writes — a generic
 * grouping hook for any caller that doesn't have its own header table to join
 * through. Exchanges don't use it: ExchangeOrder's FKs to SalesReturn and Invoice
 * already relate both legs, so no correlationId string-matching is needed there.
 */
export async function createInvoice(req, {
  items, customItems, partyId, partyName, partyPhone, partyGstin,
  billingAddress, vehicleReg,
  invoiceType,
  paymentMode, cashAmount, upiAmount, creditAmount,
  upiReference,
  marketplaceOrderId,
  notes,
  appliedCreditNoteId, appliedCreditAmount,
  correlationId,
}) {
    const hasInventoryItems = Array.isArray(items) && items.length > 0;
    const hasCustomItems    = Array.isArray(customItems) && customItems.length > 0;
    if (!hasInventoryItems && !hasCustomItems) {
      throw { status: 400, message: 'No items in invoice' };
    }

    const invType = invoiceType && VALID_INVOICE_TYPES.includes(invoiceType)
      ? invoiceType
      : (paymentMode === 'CREDIT' ? 'CREDIT' : 'RETAIL');

    // invoiceNumber is generated INSIDE the transaction below via nextSeq()
    // so the counter increment and the invoice INSERT are in the same atomic unit.

    // ── Place of supply: intra-state (CGST+SGST) vs inter-state (IGST) ─────────
    // GST law: if the buyer's state differs from the shop's, tax is IGST at the
    // full rate; otherwise it splits into CGST + SGST. The buyer's state is the
    // first 2 digits of their GSTIN; walk-in / no-GSTIN customers default to
    // intra-state (the shop's own state).
    const shopRow = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { stateCode: true } });
    const shopStateCode  = (shopRow?.stateCode || '').trim();
    const buyerStateCode = partyGstin ? String(partyGstin).trim().slice(0, 2) : '';
    const interState = !!(shopStateCode && /^\d{2}$/.test(buyerStateCode) && buyerStateCode !== shopStateCode);

    // ── Validate stock + calculate line-item totals ───────────────────────────
    const itemTotals = await computeItemTotals(req.shopId, hasInventoryItems ? items : [], invType, interState);
    let subtotal = itemTotals.subtotal, cgst = itemTotals.cgst, sgst = itemTotals.sgst, igst = itemTotals.igst;
    const processedItems = itemTotals.processedItems;

    // ── Process custom items (no inventory lookup, no stock deduction) ───────
    const processedCustomItems = [];
    if (hasCustomItems) {
      for (const ci of customItems) {
        const ciQty      = Math.max(1, parseInt(ci.qty) || 1);
        const ciUnit     = Math.max(0, parseFloat(ci.unitPrice) || 0);
        const ciDisc     = Math.min(ciUnit * 0.8, Math.max(0, parseFloat(ci.discount) || 0));
        const ciTaxable  = (ciUnit - ciDisc) * ciQty;
        const ciGstRate  = Math.max(0, parseFloat(ci.gstRate) || 0);
        const ciIgst     = interState ? ciTaxable * (ciGstRate / 100) : 0;
        const ciCgst     = interState ? 0 : ciTaxable * (ciGstRate / 2 / 100);
        const ciSgst     = ciCgst;
        const ciTotal    = ciTaxable + ciCgst + ciSgst + ciIgst;

        subtotal += ciTaxable;
        cgst     += ciCgst;
        sgst     += ciSgst;
        igst     += ciIgst;

        processedCustomItems.push({
          name:        String(ci.name  || 'Custom Item').slice(0, 200),
          brand:       ci.brand ? String(ci.brand).slice(0, 100) : null,
          oemNumber:   ci.oemNumber || null,
          mrp:         ci.mrp !== undefined && ci.mrp !== null && ci.mrp !== "" ? Number(ci.mrp) : null,
          qty:         ciQty,
          unitPrice:   ciUnit,
          discount:    ciDisc,
          taxableAmt:  ciTaxable,
          gstRate:     ciGstRate,
          cgst:        ciCgst,
          sgst:        ciSgst,
          igst:        ciIgst,
          total:       ciTotal,
          buyingPrice: Math.max(0, parseFloat(ci.buyingPrice) || 0),
        });
      }
    }

    // Round the grand total to the nearest rupee (Tally-style Round Off). The
    // rounding delta is derived at print time as totalAmount − (subtotal+cgst+sgst+igst).
    const rawTotal     = subtotal + cgst + sgst + igst;
    const totalAmount  = Math.round(rawTotal);
    const creditAmt    = creditAmount ? Math.max(0, parseFloat(creditAmount)) : 0;
    if (creditAmt > totalAmount + 0.01) {
      throw { status: 400, message: `Credit amount (₹${creditAmt.toFixed(2)}) cannot exceed invoice total (₹${totalAmount.toFixed(2)})` };
    }
    // If explicit cash + UPI amounts are provided, their combined sum must match the paid portion
    const cashAmt = cashAmount ? Math.max(0, parseFloat(cashAmount)) : 0;
    const upiAmt  = upiAmount  ? Math.max(0, parseFloat(upiAmount))  : 0;

    // ── Redeem an existing store-credit note against this sale (validated up front,
    //    consumed atomically inside the transaction to prevent double-spend) ────────
    const appliedAmt = appliedCreditAmount ? Math.max(0, parseFloat(appliedCreditAmount)) : 0;
    let creditNoteRow = null;
    if (appliedCreditNoteId) {
      creditNoteRow = await prisma.creditNote.findFirst({ where: { creditNoteId: parseInt(appliedCreditNoteId, 10), shopId: req.shopId } });
      if (!creditNoteRow) throw { status: 400, message: 'Credit note not found' };
      if (partyId && creditNoteRow.partyId && parseInt(partyId, 10) !== creditNoteRow.partyId) {
        throw { status: 400, message: 'Credit note does not belong to this customer' };
      }
      if (appliedAmt <= 0 || appliedAmt > Number(creditNoteRow.remainingBalance) + 0.01) {
        throw { status: 400, message: `Credit note has only ₹${Number(creditNoteRow.remainingBalance).toFixed(2)} remaining` };
      }
    }

    if ((cashAmt > 0 || upiAmt > 0 || appliedAmt > 0) && Math.abs(cashAmt + upiAmt + appliedAmt + creditAmt - totalAmount) > 1) {
      throw { status: 400, message: `Payment breakdown (₹${(cashAmt + upiAmt + appliedAmt + creditAmt).toFixed(2)}) must match invoice total (₹${totalAmount.toFixed(2)})` };
    }
    const isCreditSale = creditAmt > 0;
    const paidAmount   = totalAmount - creditAmt;

    // Auto-save a walk-in as a reusable customer when name + phone + vehicle are
    // all provided and no existing customer was linked. The matched/created party
    // id lands in resolvedPartyId (resolved inside the transaction below), and the
    // invoice + movements + ledger all link to it so the customer, their vehicle,
    // and their history/credit become reusable next time.
    let resolvedPartyId = partyId ? parseInt(String(partyId), 10) : null;
    const autoSaveWalkin = !partyId
      && !!(partyName    && String(partyName).trim())
      && !!(partyPhone   && String(partyPhone).trim())
      && !!(vehicleReg   && String(vehicleReg).trim())
      && invType !== 'ESTIMATE' && invType !== 'RETURN';

    // ── Create invoice + movements in a single transaction ───────────────────
    // 30s timeout: 20+ item invoices (movements + stock decrements) can exceed
    // Prisma's 5s default, causing "Transaction not found" on large bills.
    const invoice = await prisma.$transaction(async (tx) => {
      // Generate invoice number INSIDE the transaction so the counter increment
      // and the invoice INSERT are in the same atomic unit.  If the transaction
      // rolls back (e.g. stock check fails) the counter rolls back too.
      const yyyymm = currentYYYYMM();
      // Estimates (quotations) get their OWN sequence + prefix so they never
      // consume a tax-invoice number — GST requires the sales invoice series to be
      // continuous with no gaps.  Sales:    RED-S{shop}-YYYYMM-NNNN
      //                          Estimates: RED-EST-S{shop}-YYYYMM-NNNN
      const isEstimate = invType === 'ESTIMATE';
      const seq = await nextSeq(tx, req.shopId, `${isEstimate ? 'EST' : 'INV'}-${yyyymm}`);
      const invoiceNumber = `RED-${isEstimate ? 'EST-' : ''}S${req.shopId}-${yyyymm}-${String(seq).padStart(4, '0')}`;

      // ── Auto-save walk-in customer (name + phone + vehicle all present) ────────
      // Match an existing customer by phone to avoid duplicates; otherwise create
      // one. Backfills blank GSTIN/address without overwriting existing data.
      if (autoSaveWalkin && !resolvedPartyId) {
        const phone = String(partyPhone).trim();
        const existingParty = await tx.party.findFirst({
          where:  { shopId: req.shopId, phone, type: 'CUSTOMER', deletedAt: null },
          select: { partyId: true, gstin: true, address: true },
        });
        if (existingParty) {
          resolvedPartyId = existingParty.partyId;
          const patch = {};
          if (!existingParty.gstin && partyGstin)      patch.gstin   = partyGstin;
          if (!existingParty.address && billingAddress) patch.address = billingAddress;
          if (Object.keys(patch).length) {
            await tx.party.update({ where: { partyId: existingParty.partyId }, data: patch });
          }
        } else {
          const createdParty = await tx.party.create({
            data: {
              shopId:  req.shopId,
              name:    String(partyName).trim(),
              phone,
              gstin:   partyGstin    || null,
              address: billingAddress || null,
              type:    'CUSTOMER',
            },
            select: { partyId: true },
          });
          resolvedPartyId = createdParty.partyId;
        }
      }

      // ── Materialize custom items into real MasterPart + ShopInventory rows ────
      // so they're regular InvoiceItems from here on — same PDF rendering, same
      // Movement/stock-decrement path, and (critically) eligible for returns via
      // the normal getEligibleReturnItems query, which requires a real
      // InvoiceItem -> ShopInventory link. status/source 'CUSTOM' keeps them out
      // of every catalog search (those filter to status='VERIFIED') and out of
      // this shop's own browsable inventory (see inventory.js's masterPart.source
      // exclusion) — they only ever surface via this specific invoice/return.
      // Parallelize across custom items (each pair is sequential within itself
      // since the inventory create needs the masterPartId from the part create).
      const materializedCustomItems = await Promise.all(
        processedCustomItems.map(async (ci) => {
          const customPart = await tx.masterPart.create({
            data: {
              partName:           ci.name,
              brand:              ci.brand || null,
              gstRate:            ci.gstRate,
              status:             'CUSTOM',
              source:             'CUSTOM',
              unitOfSale:         'Piece',
              contributedByShopId: req.shopId,
              isUniversal:        true,
              requiresFitment:    false,
            },
          });
          const customInv = await tx.shopInventory.create({
            data: {
              shopId:         req.shopId,
              masterPartId:   customPart.masterPartId,
              sellingPrice:   ci.unitPrice,
              buyingPrice:    ci.buyingPrice || null,
              stockQty:       ci.qty,
              customPartName: ci.name,
            },
          });
          return {
            inventoryId: customInv.inventoryId,
            partName:    ci.name,
            brand:       ci.brand || null,
            hsnCode:     null,
            qty:         ci.qty,
            unitPrice:   ci.unitPrice,
            discount:    ci.discount,
            taxableAmt:  ci.taxableAmt,
            gstRate:     ci.gstRate,
            cgst:        ci.cgst,
            sgst:        ci.sgst,
            total:       ci.total,
            buyingPrice: ci.buyingPrice,
          };
        })
      );
      const allItems = [...processedItems, ...materializedCustomItems];

      const inv = await tx.invoice.create({
        data: {
          invoiceNumber,
          shopId:            req.shopId,
          partyId:           resolvedPartyId   || null,
          invoiceType:       invType,
          partyName:         partyName         || null,
          partyPhone:        partyPhone        || null,
          partyGstin:        partyGstin        || null,
          billingAddress:    billingAddress    || null,
          vehicleReg:        vehicleReg        || null,
          subtotal,
          taxableAmount:     subtotal,
          cgst,
          sgst,
          igst,
          totalAmount,
          paymentMode:       paymentMode       || 'CASH',
          cashAmount:        cashAmount        ? parseFloat(cashAmount)  : null,
          upiAmount:         upiAmount         ? parseFloat(upiAmount)   : null,
          creditAmount:      creditAmt > 0     ? creditAmt               : null,
          paidAmount,
          isCreditSale,
          upiReference:      upiReference      || null,
          marketplaceOrderId: marketplaceOrderId || null,
          status:            isCreditSale ? 'CREDIT' : 'PAID',
          notes:             notes             || null,
          // Kept for audit/back-compat even though allItems above is now the
          // source of truth for display/returns — cheap to keep, nothing reads
          // it back today.
          customItemsMeta:   processedCustomItems.length > 0 ? processedCustomItems : undefined,
          createdBy:         req.user.userId,
          items: {
            create: allItems.map(item => ({
              inventoryId: item.inventoryId,
              partName:    item.partName,
              brand:       item.brand,
              hsnCode:     item.hsnCode,
              oemNumber:   item.oemNumber || null,
              mrp:         item.mrp !== undefined && item.mrp !== null ? Number(item.mrp) : null,
              qty:         item.qty,
              unitPrice:   item.unitPrice,
              discount:    item.discount,
              taxableAmt:  item.taxableAmt,
              gstRate:     item.gstRate,
              cgst:        item.cgst,
              sgst:        item.sgst,
              igst:        item.igst || 0,
              total:       item.total,
            })),
          },
        },
        include: { items: true, shop: true },
      });

      // ── Record movements + adjust stock ──────────────────────────────────────
      // Movements are recorded for EVERY invoice type (including ESTIMATE) so the
      // sale/quotation shows in History. Stock is only changed for real SALE/RETURN
      // invoices — an ESTIMATE (quotation) is informational and must not touch stock.
      {
        const now = new Date();
        const moveType = invType === 'RETURN' ? 'RETURN_OUT' : invType === 'ESTIMATE' ? 'ESTIMATE' : 'SALE';

        await tx.movement.createMany({
          data: allItems.map(item => ({
            shopId:          req.shopId,
            inventoryId:     item.inventoryId,
            type:            moveType,
            qty:             item.qty,
            unitPrice:       item.unitPrice,
            gstRate:         item.gstRate,
            taxableAmount:   item.taxableAmt,
            totalAmount:     item.total,
            gstAmount:       item.cgst + item.sgst + (item.igst || 0),
            profit:          invType === 'ESTIMATE' ? 0 : item.taxableAmt - (item.buyingPrice * item.qty),
            invoiceId:       inv.invoiceId,
            partyId:         resolvedPartyId || null,
            referenceNumber: invoiceNumber,
            invoiceNumber,
            partyName:       partyName || null,
            paymentMode:     paymentMode || 'CASH',
            correlationId:   correlationId || null,
            createdBy:       req.user.userId,
            createdAt:       now,
          })),
        });

        if (invType === 'RETURN') {
          await Promise.all(allItems.map(item =>
            tx.shopInventory.update({
              where: { inventoryId: item.inventoryId },
              data:  { stockQty: { increment: item.qty } },
            })
          ));
        } else if (invType !== 'ESTIMATE') {
          // Atomic decrement per item — the WHERE stockQty >= qty guard prevents
          // overselling even under concurrent requests. Run in parallel since each
          // targets a different inventoryId row.
          const deductResults = await Promise.all(
            allItems.map(item =>
              tx.shopInventory.updateMany({
                where: { inventoryId: item.inventoryId, stockQty: { gte: item.qty } },
                data:  { stockQty: { decrement: item.qty }, lastSoldAt: now },
              })
            )
          );
          const failedIdx = deductResults.findIndex(r => r.count === 0);
          if (failedIdx !== -1) {
            throw { status: 400, message: `Insufficient stock for ${allItems[failedIdx].partName} — it was just sold to another customer` };
          }
        }
      }

      // ── Write PartyLedger debit if credit sale ──────────────────────────────
      if (isCreditSale && resolvedPartyId) {
        await writeLedgerDebit(tx, {
          shopId:      req.shopId,
          partyId:     resolvedPartyId,
          debitAmount: creditAmt,
          invoiceId:   inv.invoiceId,
          entryType:   'SALE_CREDIT',
          notes:       `Credit sale — Invoice ${invoiceNumber}`,
          createdBy:   req.user.userId,
        });
      }

      // ── Redeem the credit note atomically — guard prevents double-spend if two
      //    invoices try to apply the same note concurrently ───────────────────────
      if (creditNoteRow && appliedAmt > 0) {
        const consumed = await tx.creditNote.updateMany({
          where: { creditNoteId: creditNoteRow.creditNoteId, remainingBalance: { gte: appliedAmt } },
          data:  { remainingBalance: { decrement: appliedAmt } },
        });
        if (consumed.count === 0) {
          throw { status: 400, message: 'Credit note balance changed — please refresh and try again' };
        }
        const updatedNote = await tx.creditNote.findUnique({ where: { creditNoteId: creditNoteRow.creditNoteId }, select: { remainingBalance: true } });
        await tx.creditNote.update({
          where: { creditNoteId: creditNoteRow.creditNoteId },
          data:  { status: Number(updatedNote.remainingBalance) <= 0.01 ? 'FULLY_USED' : 'PARTIALLY_USED' },
        });
        if (resolvedPartyId) {
          await writeLedgerDebit(tx, {
            shopId:      req.shopId,
            partyId:     resolvedPartyId,
            debitAmount: appliedAmt,
            invoiceId:   inv.invoiceId,
            entryType:   'CREDIT_NOTE_APPLIED',
            notes:       `Applied credit note ${creditNoteRow.creditNoteNo} — Invoice ${invoiceNumber}`,
            createdBy:   req.user.userId,
          });
        }
      }

      return inv;
    }, { timeout: 30000 });

    // Best-effort: link the vehicle to the auto-saved customer. Non-fatal — the
    // sale is already committed, so a vehicle hiccup must never fail the request.
    // make/model are unknown at POS (fill later in the Vehicles screen); dedupe by
    // registration number within the shop.
    if (autoSaveWalkin && resolvedPartyId && vehicleReg) {
      try {
        const reg = String(vehicleReg).trim().toUpperCase();
        const existingVeh = await prisma.shopVehicle.findFirst({
          where:  { shopId: req.shopId, registrationNumber: reg },
          select: { vehicleId: true, ownerId: true },
        });
        if (!existingVeh) {
          await prisma.shopVehicle.create({
            data: { shopId: req.shopId, ownerId: resolvedPartyId, registrationNumber: reg, make: '', model: '' },
          });
        } else if (!existingVeh.ownerId) {
          await prisma.shopVehicle.update({ where: { vehicleId: existingVeh.vehicleId }, data: { ownerId: resolvedPartyId } });
        }
      } catch (e) {
        console.error('[billing] vehicle auto-link failed (non-fatal):', e?.message);
      }
    }

    // Audit: record sale/invoice creation (fire & forget — never blocks the response)
    writeAudit(req, {
      entityType: ET.INVOICE,
      entityId:   invoice.invoiceId,
      action:     invType === 'RETURN' ? ACT.CREATE : ACT.SALE,
      newValue: {
        invoiceNumber: invoice.invoiceNumber,
        invoiceType:   invType,
        totalAmount:   String(totalAmount),
        paymentMode:   paymentMode || 'CASH',
        itemCount:     processedItems.length + processedCustomItems.length,
        customItemCount: processedCustomItems.length || undefined,
        isCreditSale,
        partyId:       resolvedPartyId || null,
      },
    });

    incrementCounter('invoicesCreated');
    incrementCounter('invoicesTotalAmount', totalAmount);
    return invoice;
}

// ─── POST /api/billing/invoice ────────────────────────────────────────────────
router.post('/invoice', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const invoice = await createInvoice(req, req.body);
    res.json({ success: true, invoice });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ─── GET /api/billing/invoices ────────────────────────────────────────────────
router.get('/invoices', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { startDate, endDate, partyId, paymentMode, invoiceType, status, search, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };

    if (startDate)   where.createdAt = { gte: new Date(startDate) };
    if (endDate)     where.createdAt = { ...where.createdAt, lte: new Date(endDate) };
    if (partyId)     where.partyId   = partyId;
    if (paymentMode) where.paymentMode = paymentMode;
    if (invoiceType) where.invoiceType = invoiceType;
    if (status)      where.status     = status;
    // Used by the Returns/Exchange invoice picker — find an invoice by number or customer name/phone
    if (search) {
      where.OR = [
        { invoiceNumber: { contains: search, mode: 'insensitive' } },
        { partyName:      { contains: search, mode: 'insensitive' } },
        { partyPhone:      { contains: search } },
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          items:   { include: { inventory: { include: { masterPart: true } } } },
          party:   { select: { name: true } },
          payments: { orderBy: { receivedAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.invoice.count({ where }),
    ]);

    res.set('Cache-Control', 'private, max-age=15, must-revalidate');
    res.json({ success: true, invoices, total });
  } catch (err) { next(err); }
});

// ─── GET /api/billing/invoice/:id ────────────────────────────────────────────
router.get('/invoice/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where:   { invoiceId: parseInt(req.params.id, 10), shopId: req.shopId },
      include: {
        items:    { include: { inventory: { include: { masterPart: true } } } },
        party:    { select: { name: true, gstin: true, creditDays: true } },
        payments: { orderBy: { receivedAt: 'desc' } },
        shop:     true,
      },
    });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Invoice not found' } });
    res.json({ success: true, invoice });
  } catch (err) { next(err); }
});

// ─── GET /api/billing/invoice/:id/pdf ────────────────────────────────────────
// Accessible by the shop owner OR the marketplace customer linked to this invoice.
router.get('/invoice/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where:   { invoiceId: parseInt(req.params.id, 10) },
      include: { items: { include: { inventory: { include: { masterPart: true } } } }, shop: true, party: { select: { name: true, gstin: true, address: true } } },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const isShopOwner = req.user.shopId === invoice.shopId;
    let isLinkedCustomer = false;
    if (!isShopOwner && invoice.marketplaceOrderId) {
      const order = await prisma.marketplaceOrder.findFirst({
        where: { orderId: invoice.marketplaceOrderId, customerId: req.user.userId },
        select: { orderId: true },
      });
      isLinkedCustomer = !!order;
    }
    if (!isShopOwner && !isLinkedCustomer) return res.status(404).json({ error: 'Invoice not found' });

    const pdfBuffer = await generateInvoicePdf(invoice, { showOem: req.query.showOem === 'true', showMrp: req.query.showMrp === 'true' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// ─── GET /api/billing/customer/invoices — customer's own invoice history ──────
// Returns invoices linked to marketplace orders placed by the authenticated user.
router.get('/customer/invoices', authenticate, async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const parsedLimit  = Math.min(Math.max(parseInt(limit)  || 20, 1), 100);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const orders = await prisma.marketplaceOrder.findMany({
      where:  { customerId: req.user.userId },
      select: { orderId: true },
    });

    if (orders.length === 0) return res.json({ success: true, invoices: [], total: 0 });

    const orderIds = orders.map(o => o.orderId);
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where:   { marketplaceOrderId: { in: orderIds } },
        include: {
          items: true,
          shop:  { select: { shopName: true, address: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    parsedLimit,
        skip:    parsedOffset,
      }),
      prisma.invoice.count({ where: { marketplaceOrderId: { in: orderIds } } }),
    ]);

    res.json({ success: true, invoices, total });
  } catch (err) {
    console.error('[GET /billing/customer/invoices]', err);
    next(err);
  }
});

// ─── POST /api/billing/invoice/:id/send-whatsapp ─────────────────────────────
router.post('/invoice/:id/send-whatsapp', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where:   { invoiceId: parseInt(req.params.id, 10) },
      include: { items: true, shop: true },
    });
    if (!invoice || invoice.shopId !== req.shopId) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.partyPhone) return res.status(400).json({ error: 'No phone number for this customer' });

    const pdfUrl = invoice.pdfUrl || `${process.env.FRONTEND_APP_URL}/api/billing/invoice/${invoice.invoiceId}/pdf`;
    const result = await sendInvoiceWhatsApp(
      invoice.partyPhone,
      invoice.partyName,
      invoice.invoiceNumber,
      invoice.totalAmount,
      pdfUrl
    );

    // Track when WhatsApp was sent
    if (result.success) {
      await prisma.invoice.update({
        where: { invoiceId: invoice.invoiceId },
        data:  { whatsappSentAt: new Date() },
      });
    }

    res.json({ success: result.success });
  } catch (err) { next(err); }
});

// ─── PATCH /api/billing/invoice/:id/status ───────────────────────────────────
const ALLOWED_STATUS_TRANSITIONS = ['CONVERTED'];
router.patch('/invoice/:id/status', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!ALLOWED_STATUS_TRANSITIONS.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${ALLOWED_STATUS_TRANSITIONS.join(', ')}` });
    }
    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId: parseInt(req.params.id, 10), shopId: req.shopId },
      select: { invoiceId: true, invoiceType: true, status: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.invoiceType !== 'ESTIMATE') {
      return res.status(400).json({ error: 'Only ESTIMATE invoices can be marked CONVERTED' });
    }
    const updated = await prisma.invoice.update({
      where: { invoiceId: invoice.invoiceId },
      data:  { status },
    });
    writeAudit(req, { entityType: ET.INVOICE, entityId: invoice.invoiceId, action: ACT.UPDATE, newValue: { status } });
    res.json({ success: true, status: updated.status });
  } catch (err) { next(err); }
});

// ─── POST /api/billing/invoice/:id/payment ───────────────────────────────────
router.post('/invoice/:id/payment', authenticate, requireShopOwner, requirePermission('billing.payment'), async (req, res, next) => {
  try {
    const { amount, mode, reference, note } = req.body;

    if (!amount || !mode) {
      return res.status(400).json({ success: false, error: { message: 'amount and mode are required' } });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Invoice not found' } });

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: { message: 'Amount must be a positive number' } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.create({
        data: {
          invoiceId: invoice.invoiceId,
          amount:    parsedAmount,
          mode,
          reference: reference || null,
          note:      note      || null,
        },
      });

      // Write ledger credit (reduces outstanding) if party linked
      if (invoice.partyId && invoice.status === 'CREDIT') {
        await writeLedgerDebit(tx, {
          shopId:       req.shopId,
          partyId:      invoice.partyId,
          creditAmount: parsedAmount,
          invoiceId:    invoice.invoiceId,
          entryType:    'PAYMENT_RECEIVED',
          notes:        `Payment received — Invoice ${invoice.invoiceNumber} via ${mode}`,
          createdBy:    req.user.userId,
        });
      }

      // Mark invoice PAID if full amount covered
      const totalPaid = await tx.invoicePayment.aggregate({
        where: { invoiceId: invoice.invoiceId },
        _sum:  { amount: true },
      });
      const paidSoFar = parseFloat(totalPaid._sum.amount || 0);
      if (paidSoFar >= parseFloat(invoice.totalAmount)) {
        await tx.invoice.update({
          where: { invoiceId: invoice.invoiceId },
          data:  { status: 'PAID', paidAmount: paidSoFar },
        });
      }
    });

    const payments = await prisma.invoicePayment.findMany({
      where:   { invoiceId: invoice.invoiceId },
      orderBy: { receivedAt: 'desc' },
    });

    res.status(201).json({ success: true, data: payments });
  } catch (err) { next(err); }
});

export default router;
