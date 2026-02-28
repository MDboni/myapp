"use client";

import { useState } from "react";
import CategoriesTable from "../categories/categories_table";
import SubCategoriesTable from "../categories/subcategories_table";
import ProductsTable from "./products_table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PermissionLayout from "@/components/PermissonLayout/PermissonLayout";
import CollectionsPage from "@/components/collections/collections";

function Products() {
  const [activeTab, setActiveTab] = useState("products");

  return (
    <div className="px-2">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4 mt-2">
        <TabsList className="grid w-full grid-cols-4 mb-10 lg:mb-0 lg:grid-cols-4">
          <PermissionLayout permissionCode={"view_products"} showMsg={false}>
            <TabsTrigger value="products" className="flex items-center gap-1">
              <span>Products</span>
            </TabsTrigger>
          </PermissionLayout>
          <PermissionLayout permissionCode={"categories__view_category"} showMsg={false}>
            <TabsTrigger value="categories" className="flex items-center gap-1">
              <span>Categories</span>
            </TabsTrigger>
          </PermissionLayout>
          <TabsTrigger value="subcategories" className="flex items-center gap-1">
            <span>Sub Categories</span>
          </TabsTrigger>
          <TabsTrigger value="collections" className="flex items-center gap-1">
            <span>Collections</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="space-y-4">
          <ProductsTable />
        </TabsContent>
        <TabsContent value="categories" className="space-y-4">
          <CategoriesTable />
        </TabsContent>
        <TabsContent value="subcategories" className="space-y-4">
          <SubCategoriesTable />
        </TabsContent>
        <TabsContent value="collections" className="space-y-4">
          <CollectionsPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default Products;
