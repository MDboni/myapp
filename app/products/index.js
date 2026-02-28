import React, { useEffect, useMemo, useState } from "react";
import TableTopHeader from "./TableTopHeader";
import TableMain from "./MainTable/TableMain";
import { exportData, subscribe, unsubscribe } from "@/utils/helpers";
import {
  selectSearch,
  selectSingleView,
  updateAllResponse,
  updateSingleView,
} from "@/redux/state/tableState";
import { useDispatch, useSelector } from "react-redux";
import TableLoader from "./TableLoader";
import { getRequest, postRequest } from "@/utils/apiRequests";
import { useQuery } from "@tanstack/react-query";
import _debounce from "lodash/debounce";
import {
  selectProductsFilters,
  updateProductsFilters,
} from "@/redux/state/stateManage";

function TableRoot({
  store_id,
  isDemo,
  demoData,
  settings,
  dataColumns,
  tableSettings,
  setOpenRowModal,
  setOpenCellModal,
  setSingleColumnId,
  setOpenAddRow,
  expand,
  expandSetting,
  single,
  setRowSingleData,
  setSingle,
  selectedRows,
  setSelectedRows,
  exportSettings,
  setSelectTab,
  selectTab,
  setCellData,
  assignOrderActions,
  productFilter,
  isModalOpen,
  hasViewedModal,
  timeBetweenModals,
  preFIlters = [],
  buttons,
  admins,
  setAdmins,
  filterAgent,
  setFilterAgent,
  assign,
  selectedOrderIds,
  filterAgentId,
  visibleType,
  dataTransformer,
}) {
  let {
    api,
    responseData,
    primaryKey,
    primaryKeyAlias,
    apiQuery,
    customData,
    reloadEvent,
    dataLimit,
    method,
    pagination,
    date
  } = settings || {};

  let {
    expandColumn,
    expandApi,
    expandApiQuery,
    expandResponseData,
    expandReloadEvent,
    expandedCustomData,
  } = expandSetting || {};

  let { exportApi, exportApiQuery, csvTitle } = exportSettings || {};

  let { tableName } = tableSettings || {};

  const [globalFilter1, setGlobalFilter1] = useState("");
  const rerender = React.useReducer(() => ({}), {})[1];
  const [columns, setColumns] = useState(dataColumns);
  const [value, setValue] = useState([null, null]);
  const [response, setResponse] = useState(null);
  const [data, setData] = useState([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(15);
  const [query, setQuery] = useState(apiQuery || []);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [storeInvoiceId, setStoreInvoiceId] = useState([]);
  const singleView = useSelector(selectSingleView);
  const dispatch = useDispatch();
  const search = useSelector(selectSearch);

  const [filterTypes, setFilterTypes] = useState("includes_only");
  const [itemCount, setItemCount] = useState(0);

  const productFilters = useSelector(selectProductsFilters);

  // add visibleType to the query if available. IF IT CHANGES THE DATA REFETCHES
  useEffect(() => {
    if(visibleType === "visible"){
      if(!query.find(q => q.key === "only_visible")){
        setQuery(prev => [...prev, {key: "only_visible", value: true}])
        refetch();
      }
    }
    else if(visibleType === "hidden"){
      if(!query.find(q => q.key === "only_visible")){
        setQuery(prev => [...prev, {key: "only_visible", value: false}])
        refetch();
      }
    }
    else{ // all
      if(query.find(q => q.key === "only_visible")){
        setQuery(prev => prev.filter(q => q.key !== "only_visible"))
        refetch();
      }
    }
  }, [visibleType]);

  const {
    error,
    data: table_data,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: [
      `TABLE_${tableName}`,
      singleView?.name || "NO_VIEW",
      query,
      productFilters,
      date,
      itemCount,
      filterTypes
    ],
    queryFn: () => fetcher(),
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    staleTime: 0,
  });

  // const fetcher = async () => {
  //   console.log("Fetching data...");
  //   if (isDemo) {
  //     return demoDataHandler();
  //   }

  //   const url = `${process.env.APP_API_URL}${api}?1=1&${
  //     query ? query.map((item) => `${item.key}=${item.value}`).join("&") : ""
  //   }`;

  //   let x = [];

  //   if (!!productFilters?.length) {
  //     x = [
  //       {
  //         name: "sku_ids",
  //         type: filterTypes,
  //         dataType: "sku_ids",
  //         value: productFilters,
  //         ...(filterTypes === "includes_only" && itemCount > 0 && { item_count: itemCount })
  //       },
  //     ];
  //   }

  //   const postPayload = {
  //     filters:
  //       [
  //         ...(singleView?.filters?.map((item) => item.filterData) || []),
  //         ...(preFIlters?.length ? preFIlters : []),
  //         ...x,
  //       ] || x,
  //   };

  //   const request =
  //     method === "POST" ? postRequest(url, postPayload) : getRequest(url);

  //   return request;
  // };

  const fetcher = async () => {
  console.log("Fetching data...");
  if (isDemo) {
    return demoDataHandler();
  }

  // 🆕 item_count কে URL query তে যোগ করুন
  let itemCountParam = "";
  if (itemCount && itemCount > 0) {
    itemCountParam = `&item_count=${itemCount}`;
  }

  const url = `${process.env.APP_API_URL}${api}?1=1&${
    query ? query.map((item) => `${item.key}=${item.value}`).join("&") : ""
  }${itemCountParam}`;  // 🆕 এখানে যোগ করুন

  let x = [];

  if (!!productFilters?.length) {
    x = [
      {
        name: "sku_ids",
        type: filterTypes,
        dataType: "sku_ids",
        value: productFilters,
        // 🆕 এখান থেকে item_count সরিয়ে দিন (এটা আর দরকার নেই)
      },
    ];
  }

  const postPayload = {
    filters:
      [
        ...(singleView?.filters?.map((item) => item.filterData) || []),
        ...(preFIlters?.length ? preFIlters : []),
        ...x,
      ] || x,
  };

  const request =
    method === "POST" ? postRequest(url, postPayload) : getRequest(url);

  return request;
};

  useEffect(() => {
    if (isFetching) return;

    if (error) {
      console.log("Error: ", error);
      return setData([{ id: "not_found" }]);
    }
    if (!table_data?.[responseData]) return setData([{ id: "not_found" }]);

    const newRes = table_data?.[responseData]?.map((item) => ({
      ...item,
      id: item[primaryKey],
      ...customData?.reduce((acc, curr) => {
        acc[curr.key] = curr?.value
        return acc;
      }, {})
    }));
    const transformedData = dataTransformer ? dataTransformer(newRes, table_data) : newRes;

    dispatch(updateAllResponse(table_data));
    transformedData?.length > 0 ? setData(transformedData) : setData([{ id: "not_found" }]);
    setResponse(table_data);
    setPage(table_data?.page || 1);
    setLimit(table_data?.limit || 15);
    setLoading(false);
  }, [table_data, isFetching, error]);

  const debouncedReloadData = _debounce(refetch, 1000);

  useEffect(() => {
    if (!reloadEvent) return;

    const eventHandler = () => {
      if (!isFetching) {
        debouncedReloadData();
      }
    };

    subscribe(reloadEvent, eventHandler);

    return () => {
      unsubscribe(reloadEvent, eventHandler);
    };
  }, [reloadEvent, isFetching]);

  useEffect(() => {
    setColumns(dataColumns);
  }, [selectTab]);

  useEffect(() => {
    if (single && single.invoice_id) {
      if (!storeInvoiceId.includes(single.invoice_id)) {
        setStoreInvoiceId((prev) => [...prev, single.invoice_id]);
      }
    }
  }, [expanded]);

  useEffect(() => {
    if (!expand) return;
    if (!single) return;
    
    (async () => {
      const res = await getRequest(
        `${process.env.APP_API_URL}${expandApi}?${expandColumn}=${single[expandColumn]}&${
          expandApiQuery
            ? expandApiQuery.map((item) => `${item.key}=${item.value}`).join("&")
            : ""
        }`
      ).finally(() => {});

      if (!res?.[expandResponseData]) return null;

      const newRes = res?.[expandResponseData]?.map((item) => ({
        ...item,
        ...expandedCustomData?.reduce((acc, curr) => {
          acc[curr.key] = curr.value(item);
          return acc;
        }, {}),
      }));

      const newData = data?.map((item) => {
        if (item.invoice_id === single.invoice_id) {
          return {
            ...item,
            subRows: [...newRes, ...item.subRows],
          };
        }
        return item;
      });
      setData(newData);
    })();
  }, [storeInvoiceId, expand]);

  const rootSettings = {
    showTopHeader: tableSettings?.showTopHeader
      ? tableSettings?.showTopHeader
      : tableSettings?.showTopHeader === false
        ? false
        : true,
  };

  useEffect(() => {
    if (pagination) {
      const newQuery = query.map((item) => {
        if (item.key === "page") {
          item.value = page;
        } else if (item.key === "limit") {
          item.value = limit;
        } else if (item.key === "search") {
          item.value = search;
        }
        return item;
      });
      setQuery(newQuery);
    }
  }, [page, limit, search]);

  const demoDataHandler = () => {
    const newRes = demoData?.map((item) => ({
      ...item,
      id: item[primaryKey],
      ...customData?.reduce((acc, curr) => {
        acc[curr.key] = curr.value(item);
        return acc;
      }, {}),
    }));

    setData(newRes);
  };

  const handleExport = async () => {
    if (exportSettings) {
      if (selectedRows?.length === 0) {
        return alert("Please select order to export");
      } else {
        const res = await getRequest(
          `${process.env.APP_API_URL}${exportApi}?${
            exportApiQuery
              ? exportApiQuery.map((item) => `${item.key}=${item.value}`).join("&")
              : ""
          }`
        );
        exportData(res, csvTitle, "text/csv;charset=utf-8;");
      }
    }
  };

  const handleImport = async () => {
    console.log("Importing...");
  };

  return (
    <>
      {rootSettings.showTopHeader && (
        <TableTopHeader
          setGlobalFilter1={setGlobalFilter1}
          globalFilter1={globalFilter1}
          tableSettings={tableSettings}
          setOpenAddRow={setOpenAddRow}
          valueF={value}
          setValueF={setValue}
          handleExport={handleExport}
          handleImport={handleImport}
          loading2={isFetching}
          loading={loading}
          productFilter={productFilter}
          isModalOpen={isModalOpen}
          hasViewedModal={hasViewedModal}
          timeBetweenModals={timeBetweenModals}
          setFilterTypes={setFilterTypes}
          filterTypes={filterTypes}
          itemCount={itemCount}
          setItemCount={setItemCount}
          admins={admins}
          setAdmins={setAdmins}
          filterAgent={filterAgent}
          setFilterAgent={setFilterAgent}
          assign={assign}
          selectedOrderIds={selectedOrderIds}
          filterAgentId={filterAgentId}
          setSelectedRows={setSelectedRows}
          refetch={refetch}
        />
      )}
      {loading ? (
        <TableLoader />
      ) : (
        <TableMain
          productFilter={productFilter}
          columnsData={columns}
          reloadEvent={reloadEvent}
          rerender={rerender}
          setGlobalFilter={setGlobalFilter1}
          globalFilter={globalFilter1}
          dataTable={data}
          tableSettings={tableSettings}
          settings={settings}
          setOpenRowModal={setOpenRowModal}
          setOpenCellModal={setOpenCellModal}
          setRowSingleData={(val) => {
            setRowSingleData && setRowSingleData(val);
            setSingle && setSingle(val);
          }}
          setSingleColumnId={setSingleColumnId}
          setExpandedState={setExpanded}
          valueF={value}
          pagination={pagination}
          response={response}
          setPage={setPage}
          setLimit={setLimit}
          selectedRows={selectedRows}
          setSelectedRows={setSelectedRows}
          selectTab={selectTab}
          setSelectTab={setSelectTab}
          setCellData={setCellData}
          isDemo={isDemo}
          assignOrderActions={assignOrderActions}
          buttons={buttons}
        />
      )}
    </>
  );
}

export default TableRoot;
