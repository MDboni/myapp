"use client";

import React from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckCircle2, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ModalDrawer } from "@/components/shared/ModalDrawer";
import useStore from "@/lib/swr/use-store";
import { getRequest } from "@/utils/apiRequests";
import { imageGetUrl } from "@/utils/helpers";

export default function Requisition({ store: storeFromProps }) {
  const { store_id: storeIdFromHook } = useStore();
  const storeId = storeFromProps?.store_id || storeIdFromHook;

  const [search, setSearch] = React.useState("");
  const [requisitionModalOpen, setRequisitionModalOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSearch, setPickerSearch] = React.useState("");
  const [debounced] = useDebouncedValue(pickerSearch, 600, { leading: true });
  const [selectedVariants, setSelectedVariants] = React.useState([]);
  const [requisitionItems, setRequisitionItems] = React.useState([]);

  const { data, fetchNextPage, isFetching, isFetchingNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ["GET_REQUISITION_PRODUCTS_INFINITY", storeId, debounced],
    enabled: !!storeId && requisitionModalOpen && pickerOpen,
    queryFn: async ({ pageParam = 0 }) => {
      const res = await getRequest(
        `/products/all/admin?store_id=${storeId}&page=${pageParam}&limit=100&search=${debounced}`
      );
      return res;
    },
    getNextPageParam: (lastPage) => lastPage?.nextPage,
  });

  const addVariant = (variant) => {
    const exists = selectedVariants.find((item) => item?.sku_id === variant?.sku_id);
    if (exists) return;

    setSelectedVariants((prev) => [
      ...prev,
      {
        ...variant,
        product_id: variant?.product_id,
        variant_id: variant?.sku_id,
        product_name: variant?.variant_name,
        product_images: variant?.images,
        quantity: 1,
        product_price: variant?.price,
      },
    ]);
  };

  const removeVariant = (variant) => {
    setSelectedVariants((prev) => prev.filter((item) => item?.sku_id !== variant?.sku_id));
  };

  const updateVariantQuantity = (variant, quantity) => {
    setSelectedVariants((prev) =>
      prev.map((item) =>
        item?.sku_id === variant?.sku_id
          ? { ...item, quantity: quantity < 1 ? 1 : quantity }
          : item
      )
    );
  };

  const updateRequisitionItemQuantity = (variant, quantity) => {
    setRequisitionItems((prev) =>
      prev.map((item) =>
        item?.sku_id === variant?.sku_id
          ? { ...item, quantity: quantity < 1 ? 1 : quantity }
          : item
      )
    );
  };

  const removeRequisitionItem = (variant) => {
    setRequisitionItems((prev) => prev.filter((item) => item?.sku_id !== variant?.sku_id));
  };

  const filteredSelectedVariants = selectedVariants.filter((variant) =>
    (variant?.variant_name || "").toLowerCase().includes(search.toLowerCase())
  );
  const filteredRequisitionItems = requisitionItems.filter((variant) =>
    (variant?.variant_name || "").toLowerCase().includes(search.toLowerCase())
  );

  const handleCloseRequisitionModal = () => {
    setRequisitionModalOpen(false);
    setPickerOpen(false);
    setPickerSearch("");
    setSelectedVariants(requisitionItems);
  };

  const handleOpenRequisitionModal = () => {
    setSelectedVariants(requisitionItems);
    setRequisitionModalOpen(true);
  };

  const handleSubmitRequisition = () => {
    setRequisitionItems(selectedVariants);
    setRequisitionModalOpen(false);
    setPickerOpen(false);
    setPickerSearch("");
  };

  return (
    <div className="w-full h-full p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div className="relative w-full md:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            className="pl-9"
            placeholder="Search products..."
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button onClick={handleOpenRequisitionModal}>
          <Plus className="w-4 h-4 mr-2" />
          Add Requisition
        </Button>
      </div>

      <ModalDrawer
        isOpen={requisitionModalOpen}
        onClose={handleCloseRequisitionModal}
        title="Add Requisition"
        pos={true}
        nextPrev={false}
        hasBack={false}
        hasClose={true}
        menu={false}
        edit={true}
      >
        <div className="h-full flex flex-col">
          <div className="p-4 md:p-6 space-y-4 flex-1">
            <div className="flex items-center justify-end">
            <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Product
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[400px] p-4 z-50 max-h-[420px] overflow-y-auto" align="end">
                <div className="mb-4">
                  <Input
                    className="w-full"
                    placeholder="Search products..."
                    type="search"
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <DropdownMenuGroup>
                  {data?.pages?.map((group, i) => (
                    <React.Fragment key={i}>
                      {group?.products?.map((product) => (
                        <ProductCard
                          key={product?.product_id}
                          product={product}
                          selectedVariants={selectedVariants}
                          onAddVariant={addVariant}
                          onRemoveVariant={removeVariant}
                        />
                      ))}
                    </React.Fragment>
                  ))}

                  {isFetching && !isFetchingNextPage && !data?.pages?.length && (
                    <div className="text-sm text-gray-500 p-2">Loading products...</div>
                  )}

                  {!isFetching && data?.pages?.[0]?.products?.length === 0 && (
                    <div className="text-sm text-gray-500 p-2">No products found.</div>
                  )}

                  {hasNextPage && (
                    <Button onClick={() => fetchNextPage()} disabled={isFetching} variant="outline" className="w-full">
                      {isFetchingNextPage ? "Loading more..." : "Load More"}
                    </Button>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>

            <div className="rounded-md border bg-white p-3">
              <h3 className="text-sm font-semibold mb-2">Selected Products</h3>
              {filteredSelectedVariants.length === 0 ? (
                <p className="text-sm text-gray-500">No product selected.</p>
              ) : (
                <div className="space-y-2">
                  {filteredSelectedVariants.map((variant, i) => (
                    <div key={`${variant?.sku_id}-${i}`} className="flex items-center justify-between rounded-md border p-2">
                      <div>
                        <p className="text-sm font-medium">{variant?.variant_name}</p>
                        <p className="text-xs text-gray-500">{variant?.price} TK</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-500">Qty</span>
                          <Input
                            type="number"
                            min={1}
                            value={variant?.quantity ?? 1}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              if (!isNaN(val)) updateVariantQuantity(variant, val);
                            }}
                            className="h-8 w-20"
                          />
                        </div>
                        <Button size="icon" variant="ghost" onClick={() => removeVariant(variant)}>
                          <X className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="sticky bottom-0 border-t bg-zinc-100 p-4 md:p-6">
            <div className="flex justify-end">
              <Button onClick={handleSubmitRequisition}>Submit</Button>
            </div>
          </div>
        </div>
      </ModalDrawer>

      <div className="rounded-md border bg-white p-3">
        <h3 className="text-sm font-semibold mb-2">Requisition Items</h3>
        {filteredRequisitionItems.length === 0 ? (
          <p className="text-sm text-gray-500">No product selected.</p>
        ) : (
          <div className="space-y-2">
            {filteredRequisitionItems.map((variant, i) => (
              <div key={`main-${variant?.sku_id}-${i}`} className="flex items-center justify-between rounded-md border p-2">
                <div>
                  <p className="text-sm font-medium">{variant?.variant_name}</p>
                  <p className="text-xs text-gray-500">{variant?.price} TK</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-500">Qty</span>
                    <Input
                      type="number"
                      min={1}
                      value={variant?.quantity ?? 1}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) updateRequisitionItemQuantity(variant, val);
                      }}
                      className="h-8 w-20"
                    />
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeRequisitionItem(variant)}>
                    <X className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({ product, selectedVariants, onAddVariant, onRemoveVariant }) {
  const hasAnySelected = selectedVariants.find((item) => item?.product_id === product?.product_id);
  const [isCollapsed, setIsCollapsed] = React.useState(!hasAnySelected);

  return (
    <div className="mb-3 border border-gray-100 rounded-md">
      <div
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center justify-between w-full bg-gray-100 hover:bg-gray-50 cursor-pointer p-2 rounded-md"
      >
        <div className="flex items-center gap-3 flex-1">
          <div className="flex-1">
            <div className="font-medium text-sm w-full line-clamp-1">{product?.name}</div>
          </div>
        </div>
        {hasAnySelected ? (
          <Button size="icon" variant="ghost">
            <CheckCircle2 className="w-5 h-5" />
          </Button>
        ) : (
          <div className="py-4" />
        )}
      </div>

      {!isCollapsed && (
        <div className="pl-6 py-2 space-y-2">
          {product?.skus?.map((sku) => {
            const isSelected = selectedVariants.find((item) => item?.sku_id === sku?.sku_id);

            return (
              <div key={sku?.sku_id}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-3 flex-1">
                    <img
                      alt="Product Image"
                      src={imageGetUrl(sku?.images?.split(",")?.[0])}
                      className="w-8 h-8 rounded-md object-cover overflow-hidden"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-xs w-full line-clamp-1">{sku?.variant_name}</div>
                      <div className="text-xs text-gray-500">{sku?.price} TK</div>
                    </div>
                  </div>
                  {isSelected ? (
                    <Button size="icon" variant="ghost" onClick={() => onRemoveVariant(sku)}>
                      <X className="w-5 h-5 text-red-500" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        onAddVariant({
                          ...sku,
                          product_id: product?.product_id,
                          product_slug: product?.slug,
                        })
                      }
                    >
                      <Plus className="w-5 h-5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
