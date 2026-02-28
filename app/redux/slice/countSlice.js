const { createSlice } = require("@reduxjs/toolkit");
const { act } = require("react");
const initialState = [
    {id: 1, value: 10},
    {id: 2, value: 20},
    {id: 3, value: 30},
]
const countSlice = createSlice({
    name: "count",
    initialState,
    reducers:{
        increament :(state,action)=>{
            const {id} = action.payload;
            const findIndex = state.findIndex((item)=> item.id === id);
            if(findIndex !== -1){
                state[findIndex].value += 1;
            }
        },
        decrement :(state,action)=>{
            const {id} = action.payload;
            const findIndex = state.findIndex((item)=> item.id === id);
            if(findIndex !== -1){
                state[findIndex].value -= 1;
            }
        }
    }
})

export const {increament, decrement} = countSlice.actions;
export default countSlice.reducer;