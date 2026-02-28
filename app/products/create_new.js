"use client";
import * as Yup from "yup";
import React, { useEffect, useState } from "react";
import { AppForm, FormBtn, FormInput } from "@/components/shared/Form";
import { getRequest, postRequest } from "@/utils/apiRequests";
import useStore from "@/lib/swr/use-store";
import toast from "react-hot-toast";
import { publish } from "@/utils/helpers";
import Media from "@/components/Product/Media";

const validationSchema = Yup.object().shape({
    name: Yup.string().required().max(45).label("Name"),
    slug: Yup.string().required().max(45).label("Slug"),
});



const CreateNewCategory = ({ setOpen, isSubCategory = false }) => {
    const [loading, setLoading] = useState(false);
    const [images, setImages] = useState("");
    const [parentId, setParentId] = useState("");
    const [parentCategories, setParentCategories] = useState([]);
    const { store } = useStore();

    useEffect(() => {
        if (!isSubCategory || !store?.store_id) return;
        (async () => {
            const res = await getRequest(`/categories?store_id=${store?.store_id}&limit=200`);
            if (res?.status === 200) {
                const options = (res?.categories || []).filter((item) => !item?.parent_id);
                setParentCategories(options);
            }
        })();
    }, [isSubCategory, store?.store_id]);

    const handleSubmit = async (values) => {
        if (isSubCategory && !parentId) {
            return toast.error("Please select a parent category");
        }
        setLoading(true);
        const res = await postRequest(`/categories`, {
            ...values,
            image: (typeof images === "string" ? images.split(",")[0] : "") || "",
            store_id: store?.store_id,
            ...(isSubCategory ? { parent_id: Number(parentId) } : {}),
        });
        if (res?.status == 200) {
            setOpen && setOpen(false);
            setLoading(false);
            toast.success(isSubCategory ? "Sub Category created successfully" : "Category created successfully");
            publish(isSubCategory ? "GET_SUBCATEGORIES" : "GET_CATEGORIES")
        } else {
            setLoading(false);
            toast.error(res?.message || "Something went wrong");
        }
    }

    return (
        <div className="p-5">
            <AppForm
                initialValues={{
                    name: "",
                    slug: "",
                }}
                validationSchema={validationSchema}
                onSubmit={handleSubmit}
            >
                <div className="input-1 mb-7">
                    <h3 className="text-title font-semibold text-base mb-2">
                        {isSubCategory ? "Sub Category Name" : "Name"}
                    </h3>
                    <FormInput
                        name={"name"}
                        placeholder="Enter name here"
                        required
                    />
                </div>

                <div className="input-1 mb-7">
                    <h3 className="text-title font-semibold text-base mb-2">
                        Slug
                    </h3>
                    <FormInput
                        name={"slug"}
                        placeholder="Enter url slug here"
                    />
                </div>
                {isSubCategory && (
                    <div className="input-1 mb-7">
                        <h3 className="text-title font-semibold text-base mb-2">
                            Parent Category
                        </h3>
                        <select
                            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none"
                            value={parentId}
                            onChange={(e) => setParentId(e.target.value)}
                        >
                            <option value="">Select parent category</option>
                            {parentCategories?.map((item) => (
                                <option key={item?.category_id} value={item?.category_id}>
                                    {item?.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <Media
                    setImages={setImages}
                    images={images}
                    title={isSubCategory ? "Sub Category Icon" : "Category Icon"}
                />
                <FormBtn title={isSubCategory ? "Create Sub Category" : "Create"} loading={loading} disabled={loading} />
            </AppForm>
        </div>
    )

}

export default CreateNewCategory;
